import { api } from './lib/api.js';

export function createApp(root) {
  const STORAGE_KEY = 'rv4';
  const SESSION_KEY = 'rv4_session_email';
  const tabs = [
    ['dashboard', '资料总览'],
    ['library', '上传资料'],
    ['knowledge', '重点提炼'],
    ['practice', '智能刷题'],
    ['cards', '速记卡片'],
    ['mistakes', '错题本'],
    ['plan', '冲刺计划'],
    ['profile', '个人主页'],
    ['auth', '登录注册'],
  ];

  const state = {
    route: 'dashboard',
    loading: false,
    loadingText: '处理中...',
    error: '',
    files: [],
    selectedFileId: null,
    focus: null,
    cards: null,
    quiz: null,
    answers: {},
    analysis: null,
    plansByFileId: {},
    quizHistory: [],
    selectedHistoryId: null,
    cardsHistory: [],
    selectedCardHistoryId: null,
    toast: '',
    auth: {
      user: null,
      mode: 'login',
      loginEmail: '',
      loginPassword: '',
      registerEmail: '',
      registerPassword: '',
      registerPasswordConfirm: '',
      registerCodeInput: '',
      registerCodeSentAt: '',
      registerCodeCooldownUntil: 0,
      forgotEmail: '',
      forgotCodeInput: '',
      forgotCodeSentAt: '',
      forgotNewPassword: '',
      forgotNewPasswordConfirm: '',
      forgotCodeCooldownUntil: 0,
    },
    settings: {
      examDate: '',
      notes: '',
      chapter: '全部章节',
      difficulty: '中等',
      count: 6,
    },
    mistakesFilter: 'all',
    dismissedMistakes: [],
    sidebarOpen: false,
    aiChatOpen: false,
    aiChatMessages: [],
    aiChatDraft: '',
    aiChatLoading: false,
    aiChatInputHeight: 40,
    pendingDeleteMistakeKey: '',
    _scrollAiChatToBottom: false,
    _errorToken: 0,
    _scrollPracticeDetail: false,
  };
  let aiChatAbortController = null;

  const formatFileSize = (bytes) => {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  const escapeHtml = (text) =>
    String(text ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const routeFromHash = () => location.hash.replace(/^#/, '') || 'dashboard';
  const routeTitle = (id) => tabs.find(([key]) => key === id)?.[1] || '';
  const isLoggedIn = () => !!state.auth.user;
  const cooldownSeconds = (until) => Math.max(0, Math.ceil((Number(until || 0) - Date.now()) / 1000));
  const registerCodeLeft = () => cooldownSeconds(state.auth.registerCodeCooldownUntil);
  const forgotCodeLeft = () => cooldownSeconds(state.auth.forgotCodeCooldownUntil);

  const getSelectedFile = () => state.files.find((file) => file.id === state.selectedFileId) || null;
  const getSelectedText = () => getSelectedFile()?.text?.trim() || '';
  const getQuestions = () => state.quiz?.questions || [];
  const normalizeOptionText = (value) => String(value || '').replace(/^[A-Ha-h][\.\s、:：）\)]*/, '').trim();
  const normalizeChoiceToken = (value) =>
    String(value || '')
      .trim()
      .replace(/[（(].*?[）)]/g, '')
      .replace(/^[A-Ha-h][\.\s、:：）\)]*/, '')
      .trim();
  const normalizeRawChoiceAnswer = (value) => {
    const rawText = String(value || '').trim();
    if (!rawText) return rawText;
    const withColon = rawText.match(/^([A-Ha-h])\s*[：:]\s*(.+)$/);
    if (!withColon) return rawText;
    const letter = withColon[1].toUpperCase();
    const rightPart = String(withColon[2] || '').trim();
    if (!rightPart) return `${letter}.`;
    const pureText = normalizeChoiceToken(rightPart);
    return `${letter}.${pureText || rightPart}`;
  };
  const formatAnswerWithOptions = (question, answer, emptyText = '未作答') => {
    const raw = String(answer || '').trim();
    if (!raw) return emptyText;
    const options = Array.isArray(question?.options) ? question.options : [];
    if (!options.length) return normalizeRawChoiceAnswer(raw);
    const directOption = options.find((opt) => String(opt).trim() === raw);
    if (directOption) return String(directOption).trim();
    const normalizedToOptionMap = Object.fromEntries(options.map((opt) => [normalizeOptionText(opt), String(opt).trim()]));
    const tokens = raw
      .split(/[，,\s、;；/|]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const parts = tokens.length ? tokens : [raw];
    const mapped = parts.map((part) => {
      const match = String(part).trim().match(/^([A-Ha-h])(?:[\.\s、:：）\)]|$)/);
      if (match) {
        const letter = match[1].toUpperCase();
        const idx = letter.charCodeAt(0) - 65;
        const optionText = options[idx];
        if (optionText) {
          const pureOptionText = normalizeOptionText(optionText);
          return `${letter}.${pureOptionText || String(optionText).trim()}`;
        }
      }
      const normalized = normalizeChoiceToken(part);
      if (normalized && normalizedToOptionMap[normalized]) return normalizedToOptionMap[normalized];
      return String(part).trim();
    });
    return [...new Set(mapped)].join('；');
  };
  const normalizeDisplayedCorrectAnswer = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    return raw
      .replace(/^([A-Ha-h])\s*[：:]\s*\1[\.\s、:：）\)]*/g, (_m, letter) => `${String(letter).toUpperCase()}.`)
      .replace(/^([A-Ha-h])\s*[：:]\s*/g, (_m, letter) => `${String(letter).toUpperCase()}.`)
      .replace(/^([A-Ha-h])\s*[、]\s*/g, (_m, letter) => `${String(letter).toUpperCase()}.`);
  };

  /** 去掉「A： A.xxx」「A. A.xxx」等重复选项前缀，只保留一处「A.xxx」 */
  const collapseDuplicateChoiceLabel = (value) => {
    let s = String(value || '').trim();
    if (!s) return s;
    let prev;
    do {
      prev = s;
      s = s
        .replace(/([A-Ha-h])\s*[：:]\s*\1\s*\./g, '$1.')
        .replace(/([A-Ha-h])\.\s+\1\./g, '$1.');
    } while (s !== prev);
    return s;
  };

  /** 选择题正确答案统一为「选项字母.选项正文」（历史详情、错题本） */
  const normalizeChoiceCorrectSegment = (question, segment) => {
    const options = Array.isArray(question?.options) ? question.options : [];
    if (!options.length) return collapseDuplicateChoiceLabel(String(segment || '').trim());
    let trimmed = collapseDuplicateChoiceLabel(String(segment || '').trim());
    for (let i = 0; i < options.length; i++) {
      const opt = String(options[i] || '').trim();
      if (!opt) continue;
      if (trimmed === opt || normalizeOptionText(trimmed) === normalizeOptionText(opt)) {
        const letter = String.fromCharCode(65 + i);
        return `${letter}.${normalizeOptionText(opt)}`;
      }
    }
    const m = trimmed.match(/^([A-Ha-h])[\.\s、:：）\)]*(.*)$/);
    if (m) {
      const letter = m[1].toUpperCase();
      const idx = letter.charCodeAt(0) - 65;
      let rest = String(m[2] || '').trim();
      const opt = options[idx];
      if (opt) {
        const pureOpt = normalizeOptionText(opt);
        if (!rest) rest = pureOpt;
        else {
          const nr = normalizeOptionText(rest);
          rest = nr || rest;
        }
        return `${letter}.${rest}`;
      }
    }
    return trimmed;
  };

  const formatCorrectAnswerDisplay = (question, answer, emptyText = '未返回') => {
    const base = collapseDuplicateChoiceLabel(
      normalizeDisplayedCorrectAnswer(formatAnswerWithOptions(question, answer, emptyText)),
    );
    if (!base || base === emptyText) return base;
    const options = Array.isArray(question?.options) ? question.options : [];
    if (!question?.type?.includes('选择') || !options.length) return base;
    const segments = base.split(/[；;]/).map((s) => s.trim()).filter(Boolean);
    if (!segments.length) return base;
    const normalized = segments.map((seg) => normalizeChoiceCorrectSegment(question, seg));
    return [...new Set(normalized)].join('；');
  };

  const daysLeft = () => {
    if (!state.settings.examDate) return '未设置';
    const today = new Date();
    const exam = new Date(state.settings.examDate);
    today.setHours(0, 0, 0, 0);
    exam.setHours(0, 0, 0, 0);
    return Math.max(0, Math.ceil((exam - today) / 86400000));
  };

  const userStorageKey = (email) => `${STORAGE_KEY}_${email}`;
  const save = () => {
    if (!isLoggedIn()) return;
    const data = {
      files: state.files,
      selectedFileId: state.selectedFileId,
      focus: state.focus,
      cards: state.cards,
      quiz: state.quiz,
      answers: state.answers,
      analysis: state.analysis,
      plansByFileId: state.plansByFileId,
      quizHistory: state.quizHistory,
      selectedHistoryId: state.selectedHistoryId,
      cardsHistory: state.cardsHistory,
      selectedCardHistoryId: state.selectedCardHistoryId,
      settings: state.settings,
      mistakesFilter: state.mistakesFilter,
      dismissedMistakes: state.dismissedMistakes,
      aiChatMessages: state.aiChatMessages,
    };
    localStorage.setItem(userStorageKey(state.auth.user.email), JSON.stringify(data));
  };
  const load = () => {
    const sessionEmail = localStorage.getItem(SESSION_KEY);
    state.auth.user = sessionEmail ? { email: sessionEmail } : null;
    if (!state.auth.user) return;
    try {
      Object.assign(state, JSON.parse(localStorage.getItem(userStorageKey(state.auth.user.email)) || '{}'));
    } catch {}
    state.files = state.files || [];
    state.quizHistory = state.quizHistory || [];
    state.cardsHistory = state.cardsHistory || [];
    state.answers = state.answers || {};
    state.dismissedMistakes = Array.isArray(state.dismissedMistakes) ? state.dismissedMistakes : [];
    state.settings = {
      examDate: '',
      notes: '',
      chapter: '全部章节',
      difficulty: '中等',
      count: 6,
      ...(state.settings || {}),
    };
    state.plansByFileId =
      state.plansByFileId && typeof state.plansByFileId === 'object' && !Array.isArray(state.plansByFileId)
        ? state.plansByFileId
        : {};
    const legacyPlan = state.plan;
    if (legacyPlan && typeof legacyPlan === 'object') {
      const fid = state.selectedFileId || state.files[0]?.id;
      if (fid && state.plansByFileId[fid] == null) state.plansByFileId[fid] = legacyPlan;
    }
    delete state.plan;
    state.selectedCardHistoryId = null;
    state.sidebarOpen = false;
    state.aiChatOpen = false;
    state.aiChatMessages = Array.isArray(state.aiChatMessages) ? state.aiChatMessages : [];
    state.aiChatDraft = '';
    state.aiChatLoading = false;
    state.aiChatInputHeight = Math.max(40, Number(state.aiChatInputHeight) || 40);
    state._scrollAiChatToBottom = false;
    state._scrollPracticeDetail = false;
    state._errorToken = 0;
  };

  function resetUserRuntimeState() {
    state.files = [];
    state.selectedFileId = null;
    state.focus = null;
    state.cards = null;
    state.quiz = null;
    state.answers = {};
    state.analysis = null;
    state.plansByFileId = {};
    state.quizHistory = [];
    state.selectedHistoryId = null;
    state.cardsHistory = [];
    state.selectedCardHistoryId = null;
    state.mistakesFilter = 'all';
    state.dismissedMistakes = [];
  }

  let toastTimer = null;
  function showToast(msg) {
    state.toast = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      state.toast = '';
      render();
    }, 2200);
    render();
  }

  function ensureAuth(tip = '请先登录后再使用其他功能') {
    if (isLoggedIn()) return true;
    state.auth.mode = 'login';
    location.hash = '#auth';
    state.route = 'auth';
    showToast(tip);
    return false;
  }

  async function loginWithEmail(email, password) {
    await run('正在登录...', async () => {
      const data = await api.login({ email, password });
      localStorage.setItem(SESSION_KEY, data.user.email);
      state.auth.user = { email: data.user.email };
      state.auth.loginPassword = '';
      state.error = '';
      load();
      save();
      location.hash = '#dashboard';
      showToast('登录成功');
    });
  }

  async function registerWithEmail(email, password, code) {
    await run('正在注册...', async () => {
      const data = await api.register({ email, password, code });
      localStorage.setItem(SESSION_KEY, data.user.email);
      state.auth.user = { email: data.user.email };
      state.auth.registerPassword = '';
      state.auth.registerPasswordConfirm = '';
      state.auth.registerCodeInput = '';
      state.auth.registerCodeSentAt = '';
      state.auth.registerCodeCooldownUntil = 0;
      state.error = '';
      save();
      location.hash = '#dashboard';
      showToast('注册并登录成功');
    });
  }

  function logout() {
    localStorage.removeItem(SESSION_KEY);
    state.auth.user = null;
    resetUserRuntimeState();
    location.hash = '#auth';
    showToast('已退出登录');
  }

  async function deleteAccount() {
    if (!isLoggedIn()) return;
    const confirmed = window.confirm('注销后将永久删除该账号及后台数据，且无法恢复。确定继续吗？');
    if (!confirmed) return;
    const email = state.auth.user.email;
    await run('正在注销账号...', async () => {
      await api.deleteAccount({ email });
      localStorage.removeItem(userStorageKey(email));
      localStorage.removeItem(SESSION_KEY);
      state.auth.user = null;
      resetUserRuntimeState();
      location.hash = '#auth';
      showToast('账号已注销，数据已清除');
    });
  }

  async function sendRegisterCode(email) {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      showError('请先输入邮箱');
      return;
    }
    if (registerCodeLeft() > 0) return;
    await run('正在发送验证码...', async () => {
      await api.sendRegisterCode({ email: normalizedEmail });
      state.auth.registerCodeSentAt = new Date().toLocaleString('zh-CN', { hour12: false });
      state.auth.registerCodeCooldownUntil = Date.now() + 60 * 1000;
      showToast('注册验证码已发送，请查收邮箱');
    });
  }

  async function sendResetCode(email) {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) {
      showError('请先输入邮箱');
      return;
    }
    if (forgotCodeLeft() > 0) return;
    await run('正在发送验证码...', async () => {
      await api.sendResetCode({ email: normalizedEmail });
      state.auth.forgotCodeSentAt = new Date().toLocaleString('zh-CN', { hour12: false });
      state.auth.forgotCodeCooldownUntil = Date.now() + 60 * 1000;
      showToast('验证码已发送，请查收邮箱');
    });
  }

  async function resetPasswordByCode() {
    const email = state.auth.forgotEmail.trim().toLowerCase();
    const code = String(state.auth.forgotCodeInput || '').trim();
    if (!email || !code || !state.auth.forgotNewPassword || !state.auth.forgotNewPasswordConfirm) {
      showError('请完整填写邮箱、验证码和新密码');
      return;
    }
    if (state.loading) return;
    try {
      await api.verifyResetCode({ email, code });
    } catch (error) {
      window.alert(error.message || '验证码不正确');
      return;
    }
    if (state.auth.forgotNewPassword !== state.auth.forgotNewPasswordConfirm) {
      window.alert('请再次确认密码，请保证两次输入一致');
      return;
    }
    await run('正在重置密码...', async () => {
      await api.resetPassword({
        email,
        code,
        newPassword: state.auth.forgotNewPassword,
      });
      state.auth.mode = 'login';
      state.auth.loginEmail = email;
      state.auth.loginPassword = '';
      state.auth.forgotCodeInput = '';
      state.auth.forgotNewPassword = '';
      state.auth.forgotNewPasswordConfirm = '';
      showToast('密码重置成功，请重新登录');
    });
  }

  async function registerAfterChecks(email, password, code) {
    if (state.loading) return;
    try {
      await api.verifyRegisterCode({ email, code });
    } catch (error) {
      window.alert(error.message || '验证码不正确');
      return;
    }
    if (password !== state.auth.registerPasswordConfirm) {
      window.alert('请再次确认密码，请保证两次输入一致');
      return;
    }
    registerWithEmail(email, password, code);
  }

  const card = (head, body) => `<article class="panel">${head}${body}</article>`;

  let errorClearTimer = null;
  let cooldownUiTimer = null;

  function clearErrorAutoTimer() {
    if (errorClearTimer) {
      clearTimeout(errorClearTimer);
      errorClearTimer = null;
    }
  }

  function scheduleErrorAutoClear() {
    clearErrorAutoTimer();
    if (!state.error) return;
    const token = state._errorToken;
    errorClearTimer = setTimeout(() => {
      errorClearTimer = null;
      if (state._errorToken === token) {
        state.error = '';
        render();
      }
    }, 5000);
  }

  const showError = (msg) => {
    state.error = msg;
    state._errorToken += 1;
    scheduleErrorAutoClear();
    render();
  };

  function dismissError() {
    clearErrorAutoTimer();
    state.error = '';
    render();
  }

  function captureFocusContext() {
    const el = document.activeElement;
    if (!el || el === document.body || !root.contains(el)) return null;
    if (el.id) return { kind: 'css', sel: `#${CSS.escape(el.id)}` };
    const ds = el.dataset || {};
    if (ds.answer) return { kind: 'css', sel: `textarea[data-answer="${CSS.escape(ds.answer)}"]` };
    if (el.matches?.('input[type="radio"][name^="q-"]') && el.name) {
      return { kind: 'css', sel: `input[type="radio"][name="${CSS.escape(el.name)}"][value="${CSS.escape(el.value || '')}"]` };
    }
    if (ds.setting) return { kind: 'css', sel: `[data-setting="${CSS.escape(ds.setting)}"]` };
    if (ds.authField) return { kind: 'css', sel: `[data-auth-field="${CSS.escape(ds.authField)}"]` };
    if (ds.file && el.matches?.('input[type="radio"], input[type="checkbox"]')) {
      return { kind: 'css', sel: `input[data-file="${CSS.escape(ds.file)}"]` };
    }
    if (ds.filter === 'mistakes') return { kind: 'css', sel: 'select[data-filter="mistakes"]' };
    return null;
  }

  function restoreFocusContext(ctx) {
    if (!ctx || ctx.kind !== 'css') return;
    try {
      const t = root.querySelector(ctx.sel);
      if (t && typeof t.focus === 'function') t.focus({ preventScroll: true });
    } catch {
      /* ignore invalid selector */
    }
  }

  function scheduleCooldownUiTick() {
    if (cooldownUiTimer) clearTimeout(cooldownUiTimer);
    cooldownUiTimer = null;
    const onAuth = state.route === 'auth';
    if (!onAuth) return;
    updateCodeButtonsUI();
    const need = registerCodeLeft() > 0 || forgotCodeLeft() > 0;
    if (!need) return;
    cooldownUiTimer = setTimeout(scheduleCooldownUiTick, 1000);
  }

  async function run(loadingText, action) {
    if (state.loading) return;
    state.loading = true;
    state.loadingText = loadingText;
    clearErrorAutoTimer();
    state.error = '';
    render();
    try {
      await action();
    } catch (error) {
      state.error = error.message || '操作失败';
      state._errorToken += 1;
      scheduleErrorAutoClear();
    }
    state.loading = false;
    save();
    render();
  }

  function ensureSelectedFile() {
    if (!getSelectedFile()) {
      showError('请先去资料页选择一份资料（每次仅支持1份）');
      return false;
    }
    return true;
  }

  /** 与 server 端 multer `upload.array('files', N)` 的 N 保持一致 */
  const UPLOAD_FILES_PER_REQUEST = 6;

  function syncUploadDragover(zoneEl) {
    document.querySelectorAll('.upload-box--dragover').forEach((box) => {
      if (box !== zoneEl) box.classList.remove('upload-box--dragover');
    });
    if (zoneEl) zoneEl.classList.add('upload-box--dragover');
  }

  async function upload(files) {
    if (!ensureAuth()) return;
    const list = Array.from(files || []).filter((f) => f && f.size > 0);
    if (!list.length) return;
    await run('正在上传并解析资料...', async () => {
      const aggregated = [];
      for (let i = 0; i < list.length; i += UPLOAD_FILES_PER_REQUEST) {
        const chunk = list.slice(i, i + UPLOAD_FILES_PER_REQUEST);
        const data = await api.upload(chunk);
        for (const file of data.files || []) {
          aggregated.push({
            id: `f_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            name: file.name,
            size: file.size,
            type: file.type,
            text: file.text || '',
          });
        }
      }
      state.files = [...state.files, ...aggregated];
      if (!state.selectedFileId && aggregated[0]) state.selectedFileId = aggregated[0].id;
    });
    const input = document.getElementById('file-upload');
    if (input) input.value = '';
  }

  function selectFile(id) {
    if (!ensureAuth()) return;
    if (state.loading) return;
    state.selectedFileId = id;
    save();
    render();
  }

  function removeFile(id) {
    if (!ensureAuth()) return;
    if (state.loading) return;
    state.files = state.files.filter((file) => file.id !== id);
    if (state.plansByFileId[id]) {
      const nextPlans = { ...state.plansByFileId };
      delete nextPlans[id];
      state.plansByFileId = nextPlans;
    }
    if (state.selectedFileId === id) {
      state.selectedFileId = state.files[0]?.id || null;
    }
    save();
    render();
  }

  async function createFocus() {
    if (!ensureAuth()) return;
    if (!ensureSelectedFile()) return;
    await run('正在提炼重点...', async () => {
      state.focus = await api.focus({ materialText: getSelectedText(), notes: state.settings.notes });
    });
  }

  async function createCards() {
    if (!ensureAuth()) return;
    if (!ensureSelectedFile()) return;
    await run('正在生成卡片...', async () => {
      if (!state.focus) {
        state.focus = await api.focus({ materialText: getSelectedText(), notes: state.settings.notes });
      }
      state.cards = await api.cards({ materialText: getSelectedText(), focus: state.focus });
      const selected = getSelectedFile();
      const record = {
        id: `c_${Date.now()}`,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        fileId: selected?.id,
        fileName: selected?.name || '未知资料',
        cards: state.cards,
      };
      state.cardsHistory.unshift(record);
    });
  }

  async function createQuiz() {
    if (!ensureAuth()) return;
    if (!ensureSelectedFile()) return;
    await run('正在生成题目...', async () => {
      state.quiz = await api.quiz({
        materialText: getSelectedText(),
        difficulty: state.settings.difficulty,
        count: +state.settings.count || 6,
      });
      state.answers = {};
      state.analysis = null;
    });
  }

  async function analyzeQuiz() {
    if (!ensureAuth()) return;
    if (!getQuestions().length) {
      showError('请先生成题目');
      return;
    }
    await run('正在分析作答...', async () => {
      state.analysis = await api.analyzeAnswers({
        questions: getQuestions(),
        answers: getQuestions().map((q) => ({ id: q.id, answer: state.answers[q.id] || '' })),
        materialText: getSelectedText(),
      });
      const selected = getSelectedFile();
      const item = {
        id: `h_${Date.now()}`,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        fileId: selected?.id,
        fileName: selected?.name || '未知资料',
        questions: getQuestions(),
        analysis: state.analysis,
        answers: { ...state.answers },
      };
      state.quizHistory.unshift(item);
      state.selectedHistoryId = item.id;
    });
  }

  function getMistakes() {
    const dismissedSet = new Set((state.dismissedMistakes || []).map((item) => String(item)));
    return state.quizHistory
      .flatMap((item) =>
        (item.analysis?.results || [])
          .filter((r) => r.verdict !== '正确')
          .map((r) => ({
            ...r,
            historyId: item.id,
            fileId: item.fileId,
            fileName: item.fileName,
            map: Object.fromEntries((item.questions || []).map((q) => [q.id, q])),
            userAnswer: item.answers?.[r.id] || '',
            mistakeKey: `${item.id}::${r.id}`,
          })),
      )
      .filter((m) => !dismissedSet.has(m.mistakeKey))
      .filter((m) => state.mistakesFilter === 'all' || m.fileId === state.mistakesFilter);
  }

  function removeMistakeRecord(mistakeKey) {
    if (!ensureAuth()) return;
    if (!mistakeKey) return;
    state.pendingDeleteMistakeKey = String(mistakeKey);
    render();
  }

  function confirmRemoveMistakeRecord() {
    if (!ensureAuth()) return;
    const key = String(state.pendingDeleteMistakeKey || '');
    if (!key) return;
    state.pendingDeleteMistakeKey = '';
    if ((state.dismissedMistakes || []).includes(key)) return;
    state.dismissedMistakes = [...(state.dismissedMistakes || []), key];
    save();
    render();
    showToast('已从错题本删除');
  }

  function cancelRemoveMistakeRecord() {
    if (!state.pendingDeleteMistakeKey) return;
    state.pendingDeleteMistakeKey = '';
    render();
  }

  async function createPlan() {
    if (!ensureAuth()) return;
    if (!ensureSelectedFile()) return;
    await run('正在生成复习计划...', async () => {
      if (!state.focus) {
        state.focus = await api.focus({ materialText: getSelectedText(), notes: state.settings.notes });
      }
      const fileId = state.selectedFileId;
      state.plansByFileId = {
        ...state.plansByFileId,
        [fileId]: await api.plan({
          daysLeft: +daysLeft() || 7,
          focus: state.focus,
          weakPoints: getMistakes()
            .map((m) => m.matchedKnowledge || m.whyWrong)
            .filter(Boolean),
        }),
      };
    });
  }

  async function sendAiChat() {
    if (state.aiChatLoading) return;
    const message = String(state.aiChatDraft || '').trim();
    if (!message) {
      showError('请输入你想问的问题');
      return;
    }
    const selected = getSelectedFile();
    const userMessage = { role: 'user', content: message, time: Date.now() };
    state.aiChatMessages = [...state.aiChatMessages, userMessage];
    state.aiChatDraft = '';
    state.aiChatLoading = true;
    state._scrollAiChatToBottom = true;
    aiChatAbortController = new AbortController();
    render();
    try {
      const data = await api.chat({
        message,
        materialName: selected?.name || '',
        materialText: getSelectedText(),
        notes: state.settings.notes || '',
        history: state.aiChatMessages.slice(-8),
      }, {
        signal: aiChatAbortController.signal,
      });
      state.aiChatMessages = [
        ...state.aiChatMessages,
        { role: 'assistant', content: String(data?.answer || '暂时没有拿到回答，请稍后重试。'), time: Date.now() },
      ];
      state._scrollAiChatToBottom = true;
      save();
    } catch (error) {
      if (error?.name === 'AbortError') {
        state.aiChatMessages = [
          ...state.aiChatMessages,
          { role: 'assistant', content: '已停止本次回复。', time: Date.now() },
        ];
      } else {
        state.aiChatMessages = [
          ...state.aiChatMessages,
          { role: 'assistant', content: `抱歉，回答失败：${error.message || '未知错误'}`, time: Date.now() },
        ];
      }
      state._scrollAiChatToBottom = true;
    } finally {
      aiChatAbortController = null;
      state.aiChatLoading = false;
      render();
    }
  }

  function stopAiChat() {
    if (!state.aiChatLoading) return;
    aiChatAbortController?.abort();
  }

  function renderFilePicker(title, actions = '', mode = 'single') {
    const selectedFile = getSelectedFile();
    return card(
      `<div class="panel-head"><div><p class="section-tag">资料选择</p><h3>${title}</h3></div></div>`,
      `<div class="pick-list">${
        state.files.length
          ? state.files
              .map(
                (file) => `<label class="pick ${selectedFile?.id === file.id ? 'on' : ''}">
            <input type="${mode === 'single' ? 'radio' : 'checkbox'}" name="pick-file" data-file="${file.id}" ${selectedFile?.id === file.id ? 'checked' : ''}>
            <span class="file-meta">
              <span class="file-name">${escapeHtml(file.name)}</span>
              <span class="file-size">${formatFileSize(file.size)}</span>
            </span>
          </label>`,
              )
              .join('')
          : '<p class="muted">暂无资料，请先在资料页上传。</p>'
      }</div>${actions ? `<div class="action-stack top-gap">${actions}</div>` : ''}`,
    );
  }

  function renderPages() {
    const selectedFile = getSelectedFile();
    const planForSelected = selectedFile && state.plansByFileId?.[selectedFile.id] ? state.plansByFileId[selectedFile.id] : null;
    const mistakes = getMistakes();
    const mistakeFilterOptions = ['<option value="all">全部资料</option>']
      .concat(
        state.files.map(
          (file) => `<option value="${file.id}" ${state.mistakesFilter === file.id ? 'selected' : ''}>${escapeHtml(file.name)}</option>`,
        ),
      )
      .join('');

    const questionView =
      getQuestions()
        .map((q, i) => {
          const result = state.analysis?.results?.find((r) => r.id === q.id);
          const isChoice = q.type?.includes('选择');
          return `<article class="panel question-block">
            <div class="panel-head"><div><p class="section-tag">${escapeHtml(q.type || '题目')}</p><h3>第 ${i + 1} 题</h3></div><span class="pill">${escapeHtml(q.chapter || '')}</span></div>
            <p class="question-title">${escapeHtml(q.question || '')}</p>
            ${
              isChoice
                ? `<div class="option-list">${(q.options || [])
                    .map(
                      (opt) =>
                        `<label class="option-item"><input type="radio" name="q-${q.id}" value="${escapeHtml(opt)}" data-answer="${q.id}" ${
                          state.answers[q.id] === opt ? 'checked' : ''
                        }><span>${escapeHtml(opt)}</span></label>`,
                    )
                    .join('')}</div>`
                : `<textarea class="answer-box" data-answer="${q.id}">${escapeHtml(state.answers[q.id] || '')}</textarea>`
            }
            ${
              result
                ? `<div class="result-box top-gap"><strong>${escapeHtml(result.verdict || '')}</strong><p class="muted">${escapeHtml(
                    result.reviewAdvice || result.whyWrong || '',
                  )}</p></div>`
                : ''
            }
          </article>`;
        })
        .join('') || '<p class="muted">暂无题目。</p>';

    const practiceHistory = state.quizHistory.length
      ? state.quizHistory
          .map((item) => {
            const wrongCount = (item.analysis?.results || []).filter((r) => r.verdict !== '正确').length;
            return `<button class="history-row history-btn ${state.selectedHistoryId === item.id ? 'on' : ''}" data-history="${item.id}">
              <strong>${escapeHtml(item.time)}</strong>
              <p class="muted">${escapeHtml(item.fileName)}</p>
              <p class="muted">${(item.questions || []).length}题 · 错题${wrongCount}道</p>
            </button>`;
          })
          .join('')
      : '<p class="muted">还没有刷题历史。</p>';

    const selectedHistory = state.quizHistory.find((item) => item.id === state.selectedHistoryId);
    const historyDetail = selectedHistory
      ? card(
          '<div class="panel-head"><div><p class="section-tag">历史详情</p><h3>题目回看</h3></div></div>',
          (selectedHistory.questions || [])
            .map((q, idx) => {
              const result = (selectedHistory.analysis?.results || []).find((r) => r.id === q.id);
              const userAnswerRaw = selectedHistory.answers?.[q.id] || '';
              const correctAnswerRaw = result?.correctAnswer || q.answer || q.referenceAnswer || '';
              const userAnswer = formatAnswerWithOptions(q, userAnswerRaw, '未作答');
              const correctAnswer = formatCorrectAnswerDisplay(q, correctAnswerRaw, '未返回');
              const explanation = result?.reviewAdvice || result?.whyWrong || q.explanation || '无';
              const isChoice = q.type?.includes('选择');
              const optionList = isChoice
                ? `<div class="result-box top-gap"><strong>选项内容</strong>${(q.options || [])
                    .map((opt) => `<p class="muted">${escapeHtml(opt)}</p>`)
                    .join('')}</div>`
                : '';
              return `<div class="mistake-card">
                <strong>第${idx + 1}题 · ${escapeHtml(result?.verdict || '未判定')}</strong>
                <p><b>题目：</b>${escapeHtml(q.question || '')}</p>
                ${optionList}
                <p><b>你的答案：</b>${escapeHtml(userAnswer)}</p>
                <p><b>正确答案：</b>${escapeHtml(correctAnswer)}</p>
                <p class="muted"><b>解析：</b>${escapeHtml(explanation)}</p>
              </div>`;
            })
            .join(''),
        )
      : card('<p class="section-tag">历史详情</p><h3>点击左侧历史可查看</h3>', '<p class="muted">将展示题目内容、错误答案、正确答案和解析。</p>');

    const practiceHistoryBlock = card(
      '<div class="panel-head"><div><p class="section-tag">刷题历史</p><h3>点击查看完整题目详情</h3></div></div>',
      practiceHistory,
    );
    const practiceDetailWrap = `<div class="practice-detail-col" id="practice-history-detail">${historyDetail}</div>`;

    const cardHistoryList = state.cardsHistory.length
      ? state.cardsHistory
          .map(
            (record) => `<button class="history-row history-btn ${state.selectedCardHistoryId === record.id ? 'on' : ''}" data-card-history="${record.id}">
              <strong>${escapeHtml(record.time)}</strong>
              <p class="muted">${escapeHtml(record.fileName)}</p>
            </button>`,
          )
          .join('')
      : '<p class="muted">还没有卡片历史。</p>';

    const selectedCardHistory = state.cardsHistory.find((record) => record.id === state.selectedCardHistoryId);
    const cardListData = selectedCardHistory?.cards;

    return {
      dashboard: `<section class="hero panel">
        <div>
          <p class="eyebrow">学习工作台</p>
          <h2>${selectedFile ? '已选择本次学习资料' : '先去资料页上传并选择资料'}</h2>
          <p class="muted">学习过程更专注</p>
        </div>
        <div class="hero-side"><strong>${selectedFile ? `当前资料：${escapeHtml(selectedFile.name)}` : '未选择资料'}</strong></div>
      </section>
      ${card(
        '<div class="panel-head"><div><p class="section-tag">考试信息</p><h3>设置考试日期</h3></div></div>',
        `<label><span class="field-label">考试日期</span><input type="date" data-setting="examDate" value="${escapeHtml(state.settings.examDate)}"></label>`,
      )}
      <section class="stats-grid">
        <button class="stat-card panel" data-jump-route="library"><div class="stat-card__top"><span>全部资料</span><i>✦</i></div><strong>${state.files.length}</strong><p>资料页可管理增删</p></button>
        <button class="stat-card panel" data-jump-route="practice"><div class="stat-card__top"><span>刷题记录</span><i>✦</i></div><strong>${state.quizHistory.length}</strong><p>支持详情回看</p></button>
        <button class="stat-card panel" data-jump-route="cards"><div class="stat-card__top"><span>卡片历史</span><i>✦</i></div><strong>${state.cardsHistory.length}</strong><p>可直接复用</p></button>
        <article class="stat-card panel"><div class="stat-card__top"><span>倒计时</span><i>✦</i></div><strong>${daysLeft()}</strong><p>距考试</p></article>
      </section>
      ${renderFilePicker('当前学习资料（只读选择）')}`,

      library: `${card(
        '<div class="panel-head"><div><p class="section-tag">上传资料</p><h3>仅此页面可增加和删除</h3></div></div>',
        `<label class="upload-box">
          <input id="file-upload" type="file" multiple>
          <div class="upload-icon">↥</div>
          <strong>点击或拖拽上传资料</strong>
          <p>支持一次选择或拖入多份文件；超过 ${UPLOAD_FILES_PER_REQUEST} 份将自动分批解析。在资料页管理资料；其他页面仅可单选资料。</p>
        </label>
        <label class="top-gap">
          <span class="field-label">老师补充笔记</span>
          <textarea data-setting="notes">${escapeHtml(state.settings.notes)}</textarea>
        </label>`,
      )}
      ${card(
        `<div class="panel-head"><div><p class="section-tag">资料库</p><h3>${state.files.length ? `共 ${state.files.length} 份资料` : '暂无资料'}</h3></div></div>`,
        state.files.length
          ? state.files
              .map(
                (file) => `<div class="file-row">
              <label class="pick ${selectedFile?.id === file.id ? 'on' : ''}">
                <input type="radio" name="lib-file" data-file="${file.id}" ${selectedFile?.id === file.id ? 'checked' : ''}>
                <span class="file-meta"><span class="file-name">${escapeHtml(file.name)}</span><span class="file-size">${formatFileSize(
                  file.size,
                )}</span></span>
              </label>
              <button class="ghost-btn small-btn" data-del="${file.id}">删除</button>
            </div>`,
              )
              .join('')
          : '<p class="muted">上传后在这里管理资料。</p>',
      )}`,

      knowledge: `${renderFilePicker('选择要梳理的资料', '<button class="gradient-btn" data-a="focus">生成重点</button>')}
      ${
        !state.focus
          ? card('<p class="section-tag">知识解析</p><h3>还没有内容</h3>', '<p class="muted">选择资料后生成重点。</p>')
          : card(
              '<div class="panel-head"><div><p class="section-tag">重点提炼</p><h3>高频考点</h3></div></div>',
              (state.focus.highFrequencyTopics || [])
                .map(
                  (item) =>
                    `<div class="result-box top-gap">
                      <strong>${escapeHtml(item.title)} ${'★'.repeat(item.star || 1)}</strong>
                      <p class="muted">${escapeHtml(item.reason || '')}</p>
                      ${item.definition ? `<p><b>概念定义：</b>${escapeHtml(item.definition)}</p>` : ''}
                      ${
                        item.corePrinciples?.length
                          ? `<p><b>核心原理：</b></p>${item.corePrinciples
                              .map((point) => `<p class="muted">• ${escapeHtml(point)}</p>`)
                              .join('')}`
                          : ''
                      }
                      ${
                        item.examAngles?.length
                          ? `<p><b>常见考法：</b></p>${item.examAngles
                              .map((point) => `<p class="muted">• ${escapeHtml(point)}</p>`)
                              .join('')}`
                          : ''
                      }
                      ${
                        item.commonTraps?.length
                          ? `<p><b>易错陷阱：</b></p>${item.commonTraps
                              .map((point) => `<p class="muted">• ${escapeHtml(point)}</p>`)
                              .join('')}`
                          : ''
                      }
                      ${
                        item.examples?.length
                          ? `<p><b>典型例子：</b></p>${item.examples
                              .map((point) => `<p class="muted">• ${escapeHtml(point)}</p>`)
                              .join('')}`
                          : ''
                      }
                      ${item.memoryHook ? `<p><b>速记法：</b>${escapeHtml(item.memoryHook)}</p>` : ''}
                    </div>`,
                )
                .join('') + `<div class="result-box top-gap"><strong>总结</strong><p class="muted">${escapeHtml(state.focus.summary || '')}</p></div>`,
            )
      }`,

      practice: `${renderFilePicker(
        '选择本次刷题资料',
        `<div class="practice-toolbar">
          <label><span class="field-label">难度</span><select data-setting="difficulty">${['简单', '中等', '困难']
            .map((v) => `<option value="${v}" ${state.settings.difficulty === v ? 'selected' : ''}>${v}</option>`)
            .join('')}</select></label>
          <label><span class="field-label">题量</span><input type="number" min="1" max="12" data-setting="count" value="${escapeHtml(
            state.settings.count,
          )}"></label>
          <button class="gradient-btn" data-a="quiz">生成题目</button>
        </div>`,
      )}
      ${questionView}
      ${getQuestions().length ? `<div class="action-stack"><button class="gradient-btn" data-a="analyze">提交分析</button></div>` : ''}
      <div class="practice-history-split">
        <div class="practice-history-col">${practiceHistoryBlock}</div>
        ${practiceDetailWrap}
      </div>`,

      cards: `${renderFilePicker('选择要总结的资料', '<button class="gradient-btn" data-a="cards">生成卡片</button>')}
      ${card('<div class="panel-head"><div><p class="section-tag">生成历史</p><h3>同资料可直接回看</h3></div></div>', cardHistoryList)}
      ${
        !state.cardsHistory.length
          ? card('<p class="section-tag">速记卡片</p><h3>还没有内容</h3>', '<p class="muted">选择资料后生成，历史会自动保存。</p>')
          : !state.selectedCardHistoryId
            ? card(
                '<p class="section-tag">卡片内容</p><h3>请选择生成历史</h3>',
                '<p class="muted">点击上方某条记录后，将在此展示对应的速记卡片。</p>',
              )
            : card(
                '<div class="panel-head"><div><p class="section-tag">卡片内容</p><h3>速记内容</h3></div></div>',
                (cardListData?.cheatSheet || []).length
                  ? (cardListData.cheatSheet || [])
                      .map(
                        (item) =>
                          `<div class="result-box top-gap"><strong>${escapeHtml(item.title || '')}</strong>${(item.bullets || [])
                            .map((b) => `<p class="muted">• ${escapeHtml(b)}</p>`)
                            .join('')}</div>`,
                      )
                      .join('')
                  : '<p class="muted">该条记录暂无速记条目。</p>',
              )
      }`,

      mistakes: `${card(
        '<div class="panel-head"><div><p class="section-tag">筛选栏</p><h3>按资料区分错题本</h3></div></div>',
        `<label><span class="field-label">资料</span><select data-filter="mistakes">${mistakeFilterOptions}</select></label>`,
      )}
      ${card(
        '<div class="panel-head"><div><p class="section-tag">错题列表</p><h3>对应资料错题本</h3></div></div>',
        mistakes.length
          ? mistakes
              .map(
                (item) => {
                  const question = item.map[item.id] || {};
                  const userAnswer = formatAnswerWithOptions(question, item.userAnswer, '未作答');
                  const correctAnswer = formatCorrectAnswerDisplay(
                    question,
                    item.correctAnswer || question.answer || question.referenceAnswer || '',
                    '未返回',
                  );
                  const isChoice = question.type?.includes('选择');
                  const optionList = isChoice
                    ? `<div class="result-box top-gap"><strong>选项内容</strong>${(question.options || [])
                        .map((opt) => `<p class="muted">${escapeHtml(opt)}</p>`)
                        .join('')}</div>`
                    : '';
                  return `<div class="mistake-card">
              <div class="mistake-card-head">
                <strong>${escapeHtml(item.matchedKnowledge || '未识别知识点')}</strong>
                <button class="ghost-btn small-btn danger-btn" data-del-mistake="${escapeHtml(item.mistakeKey)}">删除本条</button>
              </div>
              <p class="muted">资料：${escapeHtml(item.fileName || '未知资料')}</p>
              <p>${escapeHtml(question.question || '')}</p>
              ${optionList}
              <p><b>你的答案：</b>${escapeHtml(userAnswer)}</p>
              <p><b>正确答案：</b>${escapeHtml(correctAnswer)}</p>
              <p class="muted">原因：${escapeHtml(item.whyWrong || '')}</p>
              <p class="muted">建议：${escapeHtml(item.reviewAdvice || '')}</p>
            </div>`;
                },
              )
              .join('')
          : '<p class="muted">当前筛选下暂无错题。</p>',
      )}`,

      plan: `${renderFilePicker('选择要用于计划的资料', '<button class="gradient-btn" data-a="plan">生成计划</button>')}
      ${
        !selectedFile
          ? card(
              '<p class="section-tag">复习计划</p><h3>还没有内容</h3>',
              '<p class="muted">请先上传资料并在上方选择一份资料，设置考试日期后点击「生成计划」。</p>',
            )
          : !planForSelected
            ? card(
                '<p class="section-tag">复习计划</p><h3>尚未生成冲刺计划</h3>',
                `<p class="muted">当前选中的资料「${escapeHtml(
                  selectedFile.name,
                )}」还没有对应的冲刺计划。请确认已设置考试日期，然后点击上方「生成计划」，即可<strong>仅针对该资料</strong>生成专属计划（不会影响其他资料已生成的计划）。</p>`,
              )
            : card(
                '<div class="panel-head"><div><p class="section-tag">计划概览</p><h3>你的冲刺计划</h3></div></div>',
                `<div class="result-box"><strong>资料：${escapeHtml(selectedFile.name)}</strong><br><strong>考试日期：${escapeHtml(
                  state.settings.examDate || '未设置',
                )}</strong><p class="muted">${escapeHtml(planForSelected.strategy || '')}</p></div>` +
                  (planForSelected.days || [])
                    .map(
                      (day) => `<div class="mistake-card">
                      <strong>Day ${escapeHtml(day.day || '')} · ${escapeHtml(day.theme || '')}</strong>
                      ${
                        day.timeBlocks?.length
                          ? day.timeBlocks
                              .map(
                                (block) => `<div class="result-box top-gap">
                                  <strong>${escapeHtml(block.period || '时段任务')}</strong>
                                  ${(block.tasks || []).map((task) => `<p class="muted">任务：${escapeHtml(task)}</p>`).join('')}
                                  ${(block.deliverables || []).map((d) => `<p class="muted">产出：${escapeHtml(d)}</p>`).join('')}
                                </div>`,
                              )
                              .join('')
                          : ''
                      }
                      ${
                        day.tasks?.length ? day.tasks.map((task) => `<p class="muted">• ${escapeHtml(task)}</p>`).join('') : ''
                      }
                      ${day.questionTarget ? `<p><b>刷题目标：</b>${escapeHtml(day.questionTarget)}</p>` : ''}
                      ${day.checkpoint ? `<p><b>复盘检查点：</b>${escapeHtml(day.checkpoint)}</p>` : ''}
                      ${day.priority ? `<p><b>优先级：</b>${escapeHtml(day.priority)}</p>` : ''}
                    </div>`,
                    )
                    .join(''),
              )
      }`,

      profile: `${card(
        '<div class="panel-head"><div><p class="section-tag">个人主页</p><h3>用户信息</h3></div></div>',
        isLoggedIn()
          ? `<div class="result-box"><strong>登录邮箱：${escapeHtml(state.auth.user.email)}</strong><p class="muted">你已登录，可使用全部功能。</p></div>
             <div class="stats-grid top-gap">
               <button class="stat-card panel" data-jump-route="library"><div class="stat-card__top"><span>资料数</span><i>✦</i></div><strong>${state.files.length}</strong><p>当前账号资料总数</p></button>
               <button class="stat-card panel" data-jump-route="practice"><div class="stat-card__top"><span>刷题记录</span><i>✦</i></div><strong>${state.quizHistory.length}</strong><p>历史作答次数</p></button>
               <button class="stat-card panel" data-jump-route="cards"><div class="stat-card__top"><span>卡片历史</span><i>✦</i></div><strong>${state.cardsHistory.length}</strong><p>生成卡片次数</p></button>
               <article class="stat-card panel"><div class="stat-card__top"><span>考试倒计时</span><i>✦</i></div><strong>${daysLeft()}</strong><p>距考试</p></article>
             </div>
             <div class="action-stack top-gap">
               <button class="ghost-btn" data-a="logout">退出登录</button>
               <button class="ghost-btn danger-btn" data-a="delete-account">注销账号</button>
             </div>`
          : `<div class="result-box"><strong>当前未登录</strong><p class="muted">你可以先浏览所有页面，使用具体功能时请先登录/注册。</p></div>
             <div class="action-stack top-gap"><a href="#auth" class="gradient-btn">前往登录注册</a></div>`,
      )}`,

      auth: `<section class="auth-view">
        <article class="auth-window panel">
          <div class="panel-head"><div><p class="section-tag">账号验证</p><h3>登录 / 注册</h3></div></div>
          <div class="auth-tabs top-gap">
            <button class="small-btn ${state.auth.mode === 'login' ? 'active-auth' : ''}" data-auth-mode="login">登录</button>
            <button class="small-btn ${state.auth.mode === 'register' ? 'active-auth' : ''}" data-auth-mode="register">注册</button>
            <button class="small-btn ${state.auth.mode === 'forgot' ? 'active-auth' : ''}" data-auth-mode="forgot">忘记密码</button>
          </div>
          ${
            state.auth.mode === 'login'
              ? `<div class="field-stack top-gap">
                  <label><span class="field-label">邮箱</span><input type="email" data-auth-field="loginEmail" value="${escapeHtml(state.auth.loginEmail)}"></label>
                  <label><span class="field-label">密码</span><input type="password" data-auth-field="loginPassword" value="${escapeHtml(state.auth.loginPassword)}"></label>
                  <button class="gradient-btn" data-a="login">登录</button>
                </div>`
              : ''
          }
          ${
            state.auth.mode === 'register'
              ? `<div class="field-stack top-gap">
                  <label><span class="field-label">邮箱</span><div class="action-stack"><input type="email" data-auth-field="registerEmail" value="${escapeHtml(
                    state.auth.registerEmail,
                  )}"><button class="ghost-btn" data-a="send-register-code" ${registerCodeLeft() > 0 ? 'disabled' : ''}>${
                    registerCodeLeft() > 0 ? `${registerCodeLeft()}s后重发` : '发送验证码'
                  }</button></div></label>
                  <label><span class="field-label">邮箱验证码</span><input data-auth-field="registerCodeInput" value="${escapeHtml(
                    state.auth.registerCodeInput,
                  )}"></label>
                  <p class="muted">${state.auth.registerCodeSentAt ? `最近发送：${escapeHtml(state.auth.registerCodeSentAt)}` : ''}</p>
                  <label><span class="field-label">密码</span><input type="password" data-auth-field="registerPassword" value="${escapeHtml(state.auth.registerPassword)}"></label>
                  <label><span class="field-label">确认密码</span><input type="password" data-auth-field="registerPasswordConfirm" value="${escapeHtml(
                    state.auth.registerPasswordConfirm,
                  )}"></label>
                  <button class="gradient-btn" data-a="register">注册并登录</button>
                </div>`
              : ''
          }
          ${
            state.auth.mode === 'forgot'
              ? `<div class="field-stack top-gap">
                  <label><span class="field-label">注册邮箱</span><div class="action-stack"><input type="email" data-auth-field="forgotEmail" value="${escapeHtml(
                    state.auth.forgotEmail,
                  )}"><button class="ghost-btn" data-a="send-code" ${forgotCodeLeft() > 0 ? 'disabled' : ''}>${
                    forgotCodeLeft() > 0 ? `${forgotCodeLeft()}s后重发` : '发送验证码'
                  }</button></div></label>
                  <div class="action-stack"><span class="muted">${
                    state.auth.forgotCodeSentAt ? `最近发送：${escapeHtml(state.auth.forgotCodeSentAt)}` : ''
                  }</span></div>
                  <label><span class="field-label">邮箱验证码</span><input data-auth-field="forgotCodeInput" value="${escapeHtml(state.auth.forgotCodeInput)}"></label>
                  <label><span class="field-label">新密码</span><input type="password" data-auth-field="forgotNewPassword" value="${escapeHtml(
                    state.auth.forgotNewPassword,
                  )}"></label>
                  <label><span class="field-label">确认新密码</span><input type="password" data-auth-field="forgotNewPasswordConfirm" value="${escapeHtml(
                    state.auth.forgotNewPasswordConfirm,
                  )}"></label>
                  <button class="gradient-btn" data-a="reset-password">重置密码</button>
                </div>`
              : ''
          }
        </article>
      </section>`,
    };
  }

  function render() {
    const prevMain = root.querySelector('.main-stage');
    const savedMainScrollTop = prevMain?.scrollTop ?? 0;
    const hashRoute = tabs.some(([id]) => id === routeFromHash()) ? routeFromHash() : 'dashboard';
    const keepMainScroll = state.route === hashRoute;
    state.route = hashRoute;
    const pages = renderPages();
    const selected = getSelectedFile();
    const isAuth = state.route === 'auth';
    const focusCtx = captureFocusContext();

    const shellClass = [
      'workspace-shell',
      state.loading ? 'locked' : '',
      isAuth ? 'route-auth' : '',
      state.sidebarOpen ? 'sidebar-open' : '',
      state.aiChatOpen ? 'ai-chat-open' : '',
    ]
      .filter(Boolean)
      .join(' ');

    const errorBlock = state.error
      ? `<div class="panel error-banner error-banner--row" role="alert">
        <span class="error-banner__text">${escapeHtml(state.error)}</span>
        <button type="button" class="ghost-btn small-btn error-banner__dismiss" data-dismiss-error>关闭</button>
      </div>`
      : '';

    const sidebarHtml = `<aside class="sidebar" aria-label="主导航">
        <div class="brand-block">
          <div class="brand-mark">AI</div>
          <div><strong>AI期末复习助手</strong><p>单资料专注学习</p></div>
        </div>
        <nav class="sidebar-nav">${tabs
          .filter(([id]) => id !== 'auth')
          .map(
            ([id, name]) =>
              `<a href="#${id}" class="nav-link ${state.route === id ? 'active' : ''}" data-close-sidebar-if-mobile>${name}</a>`,
          )
          .join('')}</nav>
        <div class="sidebar-panel">
          <small>当前资料</small>
          <strong>${selected ? escapeHtml(selected.name) : '未选择'}</strong>
          <small>当前账号</small>
          <strong>${isLoggedIn() ? escapeHtml(state.auth.user.email) : '未登录'}</strong>
          <small>刷题记录</small>
          <strong>${state.quizHistory.length} 次</strong>
        </div>
      </aside>`;

    const mobileTop = `<header class="mobile-shell-top">
        <button type="button" class="ghost-btn mobile-menu-btn" aria-label="打开或关闭侧栏导航" aria-expanded="${state.sidebarOpen}" data-toggle-sidebar>菜单</button>
        <strong class="mobile-shell-title">AI期末复习助手</strong>
      </header>`;

    const backdropHtml = `<div class="sidebar-backdrop" data-close-sidebar aria-hidden="true"></div>`;

    const chatMessagesHtml = state.aiChatMessages.length
      ? state.aiChatMessages
          .map(
            (item, index, list) => `<article class="ai-chat-msg ai-chat-msg--${item.role === 'assistant' ? 'ai' : 'user'} ${
              state.aiChatLoading && item.role === 'user' && index === list.length - 1 ? 'ai-chat-msg--with-stop' : ''
            }">
              <p class="ai-chat-msg__role">${item.role === 'assistant' ? 'AI助教' : '我'}</p>
              <p>${escapeHtml(item.content || '')}</p>
              ${
                state.aiChatLoading && item.role === 'user' && index === list.length - 1
                  ? '<button type="button" class="ai-chat-stop-icon ai-chat-stop-icon--on-msg" data-a="stop-ai-chat" aria-label="停止思考" title="停止思考">⏹️</button>'
                  : ''
              }
            </article>`,
          )
          .join('')
      : '<p class="muted">我是你的实时答疑助手，遇到不懂的知识点可以直接问我。</p>';
    const chatThinkingHtml = state.aiChatLoading ? '<p class="muted">AI 正在思考中...</p>' : '';

    const chatDrawerHtml = isAuth
      ? ''
      : `<aside class="ai-chat-drawer" aria-label="AI智能答疑" aria-hidden="${state.aiChatOpen ? 'false' : 'true'}">
          <div class="ai-chat-head">
            <div><p class="section-tag">实时答疑</p><h3>AI智能答疑</h3></div>
            <button type="button" class="ghost-btn small-btn" data-close-ai-chat>收起</button>
          </div>
          <div class="ai-chat-body">${chatMessagesHtml}${chatThinkingHtml}</div>
          <div class="ai-chat-input-wrap">
            <textarea data-ai-draft style="height:${state.aiChatInputHeight}px" placeholder="例如：什么是OSI模型？">${escapeHtml(state.aiChatDraft)}</textarea>
            <div class="ai-chat-actions">
              <small class="muted">Enter 发送，Shift+Enter 换行，Ctrl+I 可唤出/收起</small>
              <button type="button" class="gradient-btn" data-a="send-ai-chat" ${state.aiChatLoading ? 'disabled' : ''}>发送</button>
            </div>
          </div>
        </aside>`;

    const mainInner = isAuth
      ? pages.auth
      : `<header class="topbar" role="banner">
          <div><p class="eyebrow">智能复习系统</p><h1>${routeTitle(state.route)}</h1></div>
          <div class="topbar-actions">
            <span class="top-chip">总资料 ${state.files.length}</span>
            <span class="top-chip blue">单次仅选1份</span>
            <button type="button" class="ghost-btn small-btn" data-toggle-ai-chat>AI答疑</button>
          </div>
        </header>
        ${errorBlock}
        ${pages[state.route]}`;

    const mainClass = `main-stage${isAuth ? ' main-stage--auth' : ''}`;

    root.innerHTML = `<div class="${shellClass}" data-app-shell aria-busy="${state.loading ? 'true' : 'false'}">
      ${isAuth ? '' : mobileTop}
      ${isAuth ? '' : sidebarHtml}
      ${isAuth ? '' : backdropHtml}
      <main class="${mainClass}" aria-hidden="${state.loading ? 'true' : 'false'}">${mainInner}</main>
      ${chatDrawerHtml}
      ${isAuth ? '' : '<button type="button" class="ai-chat-fab" data-toggle-ai-chat aria-label="打开AI智能答疑">AI答疑</button>'}
    </div>
    ${
      state.loading
        ? `<div class="loading-mask" role="dialog" aria-modal="true" aria-labelledby="loading-title" aria-busy="true">
        <div class="loading-card">
          <div class="spinner" aria-hidden="true"></div>
          <strong id="loading-title">${escapeHtml(state.loadingText)}</strong>
          <p>请稍候……</p>
        </div>
      </div>`
        : ''
    }
    ${
      state.pendingDeleteMistakeKey
        ? `<div class="loading-mask" role="dialog" aria-modal="true" aria-labelledby="mistake-delete-title">
        <div class="loading-card delete-confirm-card">
          <strong id="mistake-delete-title">确认删除这条错题记录吗？</strong>
          <p>删除后将不再出现在错题本中。</p>
          <div class="action-stack delete-confirm-actions">
            <button type="button" class="ghost-btn" data-a="cancel-del-mistake">取消</button>
            <button type="button" class="ghost-btn danger-btn" data-a="confirm-del-mistake">确定</button>
          </div>
        </div>
      </div>`
        : ''
    }
    ${state.toast ? `<div class="app-toast" role="status">${escapeHtml(state.toast)}</div>` : ''}`;

    if (keepMainScroll && !isAuth) {
      const nextMain = root.querySelector('.main-stage');
      if (nextMain) {
        nextMain.scrollTop = savedMainScrollTop;
        requestAnimationFrame(() => {
          nextMain.scrollTop = savedMainScrollTop;
        });
      }
    }
    updateCodeButtonsUI();
    scheduleCooldownUiTick();
    restoreFocusContext(focusCtx);
    if (state._scrollPracticeDetail) {
      state._scrollPracticeDetail = false;
      requestAnimationFrame(() => {
        document.getElementById('practice-history-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
    if (state._scrollAiChatToBottom) {
      state._scrollAiChatToBottom = false;
      const scrollChatToBottom = () => {
        const chatBody = root.querySelector('.ai-chat-body');
        if (chatBody) chatBody.scrollTop = chatBody.scrollHeight;
      };
      scrollChatToBottom();
      requestAnimationFrame(scrollChatToBottom);
    }
    syncDrawerScrollLock();
  }

  function syncDrawerScrollLock() {
    const lock =
      state.sidebarOpen &&
      state.route !== 'auth' &&
      typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 960px)').matches;
    document.documentElement.classList.toggle('drawer-scroll-lock', lock);
    document.body.classList.toggle('drawer-scroll-lock', lock);
  }

  function updateCodeButtonsUI() {
    const registerBtn = root.querySelector('[data-a="send-register-code"]');
    if (registerBtn) {
      const left = registerCodeLeft();
      registerBtn.disabled = left > 0;
      registerBtn.textContent = left > 0 ? `${left}s后重发` : '发送验证码';
    }
    const forgotBtn = root.querySelector('[data-a="send-code"]');
    if (forgotBtn) {
      const left = forgotCodeLeft();
      forgotBtn.disabled = left > 0;
      forgotBtn.textContent = left > 0 ? `${left}s后重发` : '发送验证码';
    }
  }

  document.addEventListener('click', (event) => {
    if (state.loading) return;
    if (event.target.closest('[data-dismiss-error]')) {
      dismissError();
      return;
    }
    if (event.target.closest('[data-toggle-sidebar]')) {
      state.sidebarOpen = !state.sidebarOpen;
      render();
      return;
    }
    if (event.target.closest('[data-toggle-ai-chat]')) {
      state.aiChatOpen = !state.aiChatOpen;
      if (state.aiChatOpen) state._scrollAiChatToBottom = true;
      render();
      return;
    }
    if (event.target.closest('[data-close-ai-chat]')) {
      state.aiChatOpen = false;
      render();
      return;
    }
    if (event.target.closest('[data-close-sidebar]')) {
      state.sidebarOpen = false;
      render();
      return;
    }
    const navMobile = event.target.closest('a[data-close-sidebar-if-mobile]');
    if (navMobile && window.matchMedia('(max-width: 960px)').matches) {
      state.sidebarOpen = false;
      render();
    }
    const action = event.target.closest('[data-a]')?.dataset.a;
    const jumpRoute = event.target.closest('[data-jump-route]')?.dataset.jumpRoute;
    const fileId = event.target.closest('[data-del]')?.dataset.del;
    const mistakeKey = event.target.closest('[data-del-mistake]')?.dataset.delMistake;
    const historyId = event.target.closest('[data-history]')?.dataset.history;
    const cardHistoryId = event.target.closest('[data-card-history]')?.dataset.cardHistory;

    const authMode = event.target.closest('[data-auth-mode]')?.dataset.authMode;
    if (authMode) {
      state.auth.mode = authMode;
      clearErrorAutoTimer();
      state.error = '';
      render();
      return;
    }
    if (fileId) return removeFile(fileId);
    if (mistakeKey) return removeMistakeRecord(mistakeKey);
    if (historyId) {
      state.selectedHistoryId = historyId;
      if (state.route === 'practice') state._scrollPracticeDetail = true;
      save();
      render();
      return;
    }
    if (cardHistoryId) {
      state.selectedCardHistoryId = cardHistoryId;
      save();
      render();
      return;
    }
    if (jumpRoute) {
      location.hash = `#${jumpRoute}`;
      return;
    }
    if (!action) return;
    if (action === 'focus') createFocus();
    if (action === 'quiz') createQuiz();
    if (action === 'analyze') analyzeQuiz();
    if (action === 'cards') createCards();
    if (action === 'plan') createPlan();
    if (action === 'logout') logout();
    if (action === 'delete-account') deleteAccount();
    if (action === 'login') {
      const email = state.auth.loginEmail.trim().toLowerCase();
      if (!email || !state.auth.loginPassword) {
        showError('请输入邮箱和密码');
        return;
      }
      loginWithEmail(email, state.auth.loginPassword);
    }
    if (action === 'register') {
      const email = state.auth.registerEmail.trim().toLowerCase();
      const code = String(state.auth.registerCodeInput || '').trim();
      if (!email || !code || !state.auth.registerPassword || !state.auth.registerPasswordConfirm) {
        showError('请输入邮箱、验证码、密码及确认密码');
        return;
      }
      registerAfterChecks(email, state.auth.registerPassword, code);
    }
    if (action === 'send-register-code') sendRegisterCode(state.auth.registerEmail);
    if (action === 'send-code') sendResetCode(state.auth.forgotEmail.trim().toLowerCase());
    if (action === 'reset-password') resetPasswordByCode();
    if (action === 'send-ai-chat') sendAiChat();
    if (action === 'stop-ai-chat') stopAiChat();
    if (action === 'confirm-del-mistake') confirmRemoveMistakeRecord();
    if (action === 'cancel-del-mistake') cancelRemoveMistakeRecord();
  });

  document.addEventListener('mousedown', (event) => {
    const textarea = event.target.closest?.('textarea[data-ai-draft]');
    if (!textarea) return;
    const rect = textarea.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    if (offsetY > 8) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = rect.height || 40;
    let nextHeight = startHeight;

    const onMove = (moveEvent) => {
      const delta = startY - moveEvent.clientY;
      nextHeight = Math.max(40, Math.min(280, Math.round(startHeight + delta)));
      textarea.style.height = `${nextHeight}px`;
    };

    const onUp = () => {
      state.aiChatInputHeight = Math.max(40, Math.min(280, Math.round(nextHeight)));
      document.body.classList.remove('ai-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    document.body.classList.add('ai-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });

  document.addEventListener('dragover', (event) => {
    const zone = event.target.closest?.('.upload-box');
    if (zone) {
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = 'copy';
      } catch {
        /* ignore */
      }
    }
    syncUploadDragover(zone || null);
  });

  document.addEventListener('drop', (event) => {
    const zone = event.target.closest?.('.upload-box');
    syncUploadDragover(null);
    if (!zone) return;
    event.preventDefault();
    const dt = event.dataTransfer;
    if (!dt?.files?.length) return;
    upload(Array.from(dt.files));
  });

  document.addEventListener('dragend', () => syncUploadDragover(null));

  document.addEventListener('change', (event) => {
    if (state.loading && event.target.id !== 'file-upload') return;
    if (event.target.id === 'file-upload') {
      upload(Array.from(event.target.files || []).filter((f) => f.size > 0));
    }
    if (event.target.dataset.file) selectFile(event.target.dataset.file);
    if (event.target.dataset.setting) {
      state.settings[event.target.dataset.setting] = event.target.value;
      save();
      render();
    }
    if (event.target.dataset.answer) {
      state.answers[event.target.dataset.answer] = event.target.value;
      save();
    }
    if (event.target.dataset.filter === 'mistakes') {
      if (!ensureAuth()) return;
      state.mistakesFilter = event.target.value;
      save();
      render();
    }
    if (event.target.dataset.authField) {
      state.auth[event.target.dataset.authField] = event.target.value;
    }
  });

  document.addEventListener('input', (event) => {
    if (state.loading) return;
    if (event.target.dataset.setting) {
      state.settings[event.target.dataset.setting] = event.target.value;
      save();
    }
    if (event.target.dataset.answer) {
      state.answers[event.target.dataset.answer] = event.target.value;
      save();
    }
    if (event.target.dataset.authField) {
      state.auth[event.target.dataset.authField] = event.target.value;
    }
    if (event.target.dataset.aiDraft != null) {
      state.aiChatDraft = event.target.value;
    }
  });

  document.addEventListener('keydown', (event) => {
    const aiDraftEl = event.target?.closest?.('textarea[data-ai-draft]');
    if (aiDraftEl) {
      const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter';
      if (!isEnter || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      state.aiChatDraft = aiDraftEl.value;
      sendAiChat();
      return;
    }
    if (!event.ctrlKey || event.key.toLowerCase() !== 'i') return;
    event.preventDefault();
    if (state.route === 'auth') return;
    state.aiChatOpen = !state.aiChatOpen;
    if (state.aiChatOpen) state._scrollAiChatToBottom = true;
    render();
  });

  window.addEventListener('hashchange', () => {
    state.sidebarOpen = false;
    render();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 960 && state.sidebarOpen) {
      state.sidebarOpen = false;
      render();
    }
  });
  load();
  render();
}
