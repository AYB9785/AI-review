import express from 'express';
import cors from 'cors';
import multer from 'multer';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import nodemailer from 'nodemailer';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns';
import { extractFileText, normalizeUploadedFilename } from './textExtract.js';

// 强制 IPv4 优先：smtp.163.com 等国内邮件服务器常解析出境外不可达的 IPv6 地址
dns.setDefaultResultOrder('ipv4first');

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '4mb' }));

const model = process.env.AI_MODEL || 'gpt-4.1-mini';
const port = Number(process.env.PORT || 8787);
const hasApiKey = Boolean(process.env.AI_API_KEY);
const usersDbPath = path.resolve(process.cwd(), 'server', 'data', 'users.json');

const smtpHost = process.env.SMTP_HOST || '';
const smtpPort = Number(process.env.SMTP_PORT || 465);
const smtpSecure = String(process.env.SMTP_SECURE || 'true') !== 'false';
const smtpUser = process.env.SMTP_USER || '';
const smtpPass = process.env.SMTP_PASS || '';
const mailFrom = process.env.MAIL_FROM || smtpUser;
const canSendMail = Boolean(smtpHost && smtpUser && smtpPass && mailFrom);
// Resend 海外邮件 API：部署到境外平台时国内 SMTP（163/QQ）不可达，优先走 Resend
const resendApiKey = process.env.RESEND_API_KEY || '';
const resendFrom = process.env.RESEND_FROM || mailFrom;
const MAX_AI_INPUT_CHARS = Number(process.env.AI_INPUT_MAX_CHARS || 18000);

/**
 * 统一邮件发送：配置了 RESEND_API_KEY 时走 Resend API，否则走 SMTP（nodemailer）。
 */
async function sendMailSafe({ to, subject, text, html }) {
  if (resendApiKey) {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({ from: resendFrom, to: [to], subject, text, html }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const error = new Error(`邮件服务发送失败（Resend HTTP ${resp.status}）：${String(body).slice(0, 200)}`);
      error.status = 502;
      throw error;
    }
    return;
  }
  await ensureMailerReady();
  await mailTransporter.sendMail({ from: mailFrom, to, subject, text, html });
}

let mailTransporter = null;
let mailInit = Promise.resolve();

if (canSendMail) {
  // 强制用 IPv4 地址连接：smtp.163.com 常解析出境外不可达的 IPv6 地址（ENETUNREACH）
  mailInit = (async () => {
    let host = smtpHost;
    let servername = undefined;
    try {
      const addrs = await dns.promises.resolve4(smtpHost);
      if (addrs && addrs.length) {
        host = addrs[0];
        servername = smtpHost; // SNI 保持域名，保证 TLS 证书校验通过
      }
    } catch {}
    mailTransporter = nodemailer.createTransport({
      host,
      port: smtpPort,
      secure: smtpSecure,
      connectionTimeout: 10000,
      socketTimeout: 15000,
      greetingTimeout: 10000,
      tls: servername ? { servername } : undefined,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
  })();
}

const client = hasApiKey
  ? new OpenAI({
      apiKey: process.env.AI_API_KEY,
      baseURL: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
    })
  : null;

function ensureApiKey() {
  if (!hasApiKey || !client) {
    const error = new Error('缺少 AI_API_KEY，请先在 .env 中配置');
    error.status = 400;
    throw error;
  }
}

function cleanJson(text) {
  return String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
}

function limitText(text = '', maxChars = MAX_AI_INPUT_CHARS) {
  const raw = String(text || '').trim();
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n\n【内容过长，已截断以保证稳定生成】`;
}

function safeStringify(value, fallback = '{}') {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return fallback;
  }
}

function tryParseJson(raw) {
  const cleaned = cleanJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = cleaned.slice(firstBrace, lastBrace + 1);
      return JSON.parse(candidate);
    }
    throw new Error('JSON parse failed');
  }
}

function normalizeFocusResult(data) {
  const topics = Array.isArray(data?.highFrequencyTopics) ? data.highFrequencyTopics : [];
  return {
    ...data,
    highFrequencyTopics: topics.map((item) => {
      const reason = String(item?.reason || '').trim();
      const definition = String(item?.definition || reason || '资料未覆盖').trim();
      return {
        title: String(item?.title || '未命名考点').trim(),
        star: Number(item?.star || 1),
        reason,
        definition,
        corePrinciples: Array.isArray(item?.corePrinciples) && item.corePrinciples.length ? item.corePrinciples : ['资料未覆盖'],
        examAngles: Array.isArray(item?.examAngles) && item.examAngles.length ? item.examAngles : ['资料未覆盖'],
        commonTraps: Array.isArray(item?.commonTraps) && item.commonTraps.length ? item.commonTraps : ['资料未覆盖'],
        examples: Array.isArray(item?.examples) && item.examples.length ? item.examples : ['资料未覆盖'],
        memoryHook: String(item?.memoryHook || '').trim() || '资料未覆盖',
      };
    }),
  };
}

function normalizeEmail(value = '') {
  return String(value).trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function ensureStrongEnoughPassword(password = '') {
  if (String(password).length < 6) {
    const error = new Error('密码至少 6 位');
    error.status = 400;
    throw error;
  }
}

async function ensureMailerReady() {
  await mailInit;
  if (!mailTransporter) {
    const error = new Error('邮件服务未配置，请在 .env 中设置 SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM');
    error.status = 500;
    throw error;
  }
}

async function ensureUsersDbFile() {
  const dir = path.dirname(usersDbPath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(usersDbPath);
  } catch {
    await fs.writeFile(usersDbPath, '[]', 'utf8');
  }
}

async function readUsers() {
  await ensureUsersDbFile();
  const raw = await fs.readFile(usersDbPath, 'utf8');
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeUsers(users) {
  await ensureUsersDbFile();
  await fs.writeFile(usersDbPath, JSON.stringify(users, null, 2), 'utf8');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const digest = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, digest] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(digest));
}

async function askAI(system, input, schemaHint) {
  ensureApiKey();
  const userPrompt = `${input}\n\n请只返回 JSON。JSON 结构要求：${schemaHint}`;
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.4,
    max_tokens: 2800,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = completion?.choices?.[0]?.message?.content;
  if (!content) {
    const error = new Error('AI 服务未返回有效内容，请稍后重试');
    error.status = 502;
    throw error;
  }

  try {
    return tryParseJson(content);
  } catch {
    const repair = await client.chat.completions.create({
      model,
      temperature: 0.1,
      max_tokens: 2800,
      messages: [
        { role: 'system', content: '你是 JSON 修复器。请把给定文本修复成合法 JSON，且结构必须匹配要求。只输出 JSON，不要任何解释。' },
        {
          role: 'user',
          content: `目标 JSON 结构：${schemaHint}\n\n原始内容：\n${content}`,
        },
      ],
    });
    const repaired = repair?.choices?.[0]?.message?.content;
    if (!repaired) {
      const error = new Error('AI 返回格式异常，请稍后重试');
      error.status = 502;
      throw error;
    }
    try {
      return tryParseJson(repaired);
    } catch {
      const error = new Error('AI 返回格式异常，请稍后重试');
      error.status = 502;
      throw error;
    }
  }
}

async function askAIPlainText(system, input) {
  ensureApiKey();
  const completion = await client.chat.completions.create({
    model,
    temperature: 0.5,
    max_tokens: 1600,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: input },
    ],
  });

  const content = completion?.choices?.[0]?.message?.content;
  if (!content) {
    const error = new Error('AI 服务未返回有效内容，请稍后重试');
    error.status = 502;
    throw error;
  }
  return String(content).trim();
}

app.get('/api/health', (_, res) => {
  res.json({ ok: true, model, hasApiKey });
});

app.post('/api/upload', upload.array('files', 6), async (req, res, next) => {
  try {
    const files = req.files || [];
    const parsedFiles = [];
    for (const file of files) {
      const normalizedName = normalizeUploadedFilename(file.originalname);
      file.originalname = normalizedName;
      const text = await extractFileText(file);
      parsedFiles.push({
        name: normalizedName,
        size: file.size,
        type: file.mimetype,
        text,
      });
    }
    res.json({
      files: parsedFiles,
      text: parsedFiles
        .map((file) => `【${file.name}】\n${file.text}`)
        .join('\n\n')
        .slice(0, 30000),
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    const code = String(req.body?.code || '').trim();
    if (!isValidEmail(email)) {
      const error = new Error('请输入有效邮箱');
      error.status = 400;
      throw error;
    }
    ensureStrongEnoughPassword(password);
    const users = await readUsers();
    const existingUser = users.find((item) => item.email === email);
    if (existingUser) {
      const error = new Error('该邮箱已注册，请直接登录');
      error.status = 409;
      throw error;
    }
    if (!code) {
      const error = new Error('请输入邮箱验证码');
      error.status = 400;
      throw error;
    }
    const registerCodes = users.filter(
      (item) => item.email === `__register_code__:${email}` && item.registerCode,
    );
    const latestRegisterCode = registerCodes.sort(
      (a, b) => Number(b.registerCodeExpiresAt || 0) - Number(a.registerCodeExpiresAt || 0),
    )[0];
    if (!latestRegisterCode || !latestRegisterCode.registerCodeExpiresAt || Number(latestRegisterCode.registerCodeExpiresAt) < Date.now()) {
      const error = new Error('验证码已过期，请重新发送');
      error.status = 400;
      throw error;
    }
    if (latestRegisterCode.registerCode !== code) {
      const error = new Error('验证码错误');
      error.status = 400;
      throw error;
    }
    const usersWithoutRegisterCode = users.filter((item) => item.email !== `__register_code__:${email}`);
    usersWithoutRegisterCode.push({
      email,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
      resetCode: null,
      resetExpiresAt: null,
    });
    await writeUsers(usersWithoutRegisterCode);
    res.json({ ok: true, user: { email } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/send-register-code', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      const error = new Error('请输入有效邮箱');
      error.status = 400;
      throw error;
    }
    const users = await readUsers();
    if (users.some((item) => item.email === email)) {
      const error = new Error('该邮箱已注册，请直接登录');
      error.status = 409;
      throw error;
    }
    const code = `${Math.floor(100000 + Math.random() * 900000)}`;
    const usersWithoutRegisterCode = users.filter((item) => item.email !== `__register_code__:${email}`);
    usersWithoutRegisterCode.push({
      email: `__register_code__:${email}`,
      passwordHash: '',
      createdAt: new Date().toISOString(),
      registerCode: code,
      registerCodeExpiresAt: Date.now() + 10 * 60 * 1000,
    });
    await writeUsers(usersWithoutRegisterCode);

    await sendMailSafe({
      to: email,
      subject: 'AI期末复习助手 - 注册验证码',
      text: `你的注册验证码是：${code}\n10分钟内有效。如非本人操作请忽略。`,
      html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.8">
        <h2>注册验证码</h2>
        <p>你的验证码是：<strong style="font-size:20px;letter-spacing:2px">${code}</strong></p>
        <p>10分钟内有效。如非本人操作，请忽略此邮件。</p>
      </div>`,
    });

    res.json({ ok: true, message: '验证码已发送，请查收邮箱' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/verify-register-code', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!isValidEmail(email)) {
      const error = new Error('请输入有效邮箱');
      error.status = 400;
      throw error;
    }
    if (!code) {
      const error = new Error('请输入邮箱验证码');
      error.status = 400;
      throw error;
    }
    const users = await readUsers();
    const registerCodes = users.filter(
      (item) => item.email === `__register_code__:${email}` && item.registerCode,
    );
    const latestRegisterCode = registerCodes.sort(
      (a, b) => Number(b.registerCodeExpiresAt || 0) - Number(a.registerCodeExpiresAt || 0),
    )[0];
    if (
      !latestRegisterCode ||
      !latestRegisterCode.registerCodeExpiresAt ||
      Number(latestRegisterCode.registerCodeExpiresAt) < Date.now()
    ) {
      const error = new Error('验证码已过期，请重新发送');
      error.status = 400;
      throw error;
    }
    if (latestRegisterCode.registerCode !== code) {
      const error = new Error('验证码错误');
      error.status = 400;
      throw error;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || '');
    if (!email || !password) {
      const error = new Error('请输入邮箱和密码');
      error.status = 400;
      throw error;
    }
    const users = await readUsers();
    const user = users.find((item) => item.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      const error = new Error('邮箱或密码错误');
      error.status = 401;
      throw error;
    }
    res.json({ ok: true, user: { email: user.email } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/send-reset-code', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      const error = new Error('请输入有效邮箱');
      error.status = 400;
      throw error;
    }
    const users = await readUsers();
    const user = users.find((item) => item.email === email);
    if (!user) {
      const error = new Error('邮箱未注册，请先注册');
      error.status = 404;
      throw error;
    }
    const code = `${Math.floor(100000 + Math.random() * 900000)}`;
    user.resetCode = code;
    user.resetExpiresAt = Date.now() + 10 * 60 * 1000;
    user.resetRequestedAt = new Date().toISOString();
    await writeUsers(users);

    await sendMailSafe({
      to: email,
      subject: 'AI期末复习助手 - 密码重置验证码',
      text: `你的验证码是：${code}\n10分钟内有效。如非本人操作请忽略。`,
      html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.8">
        <h2>密码重置验证码</h2>
        <p>你的验证码是：<strong style="font-size:20px;letter-spacing:2px">${code}</strong></p>
        <p>10分钟内有效。如非本人操作，请忽略此邮件。</p>
      </div>`,
    });

    res.json({ ok: true, message: '验证码已发送，请查收邮箱' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/verify-reset-code', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    if (!isValidEmail(email) || !code) {
      const error = new Error('请完整填写邮箱和验证码');
      error.status = 400;
      throw error;
    }
    const users = await readUsers();
    const user = users.find((item) => item.email === email);
    if (!user) {
      const error = new Error('邮箱未注册');
      error.status = 404;
      throw error;
    }
    if (!user.resetCode || !user.resetExpiresAt || Number(user.resetExpiresAt) < Date.now()) {
      const error = new Error('验证码已过期，请重新发送');
      error.status = 400;
      throw error;
    }
    if (user.resetCode !== code) {
      const error = new Error('验证码错误');
      error.status = 400;
      throw error;
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || '').trim();
    const newPassword = String(req.body?.newPassword || '');
    if (!isValidEmail(email) || !code || !newPassword) {
      const error = new Error('请完整填写邮箱、验证码和新密码');
      error.status = 400;
      throw error;
    }
    ensureStrongEnoughPassword(newPassword);
    const users = await readUsers();
    const user = users.find((item) => item.email === email);
    if (!user) {
      const error = new Error('邮箱未注册');
      error.status = 404;
      throw error;
    }
    if (!user.resetCode || !user.resetExpiresAt || Number(user.resetExpiresAt) < Date.now()) {
      const error = new Error('验证码已过期，请重新发送');
      error.status = 400;
      throw error;
    }
    if (user.resetCode !== code) {
      const error = new Error('验证码错误');
      error.status = 400;
      throw error;
    }
    user.passwordHash = hashPassword(newPassword);
    user.resetCode = null;
    user.resetExpiresAt = null;
    user.updatedAt = new Date().toISOString();
    await writeUsers(users);
    res.json({ ok: true, message: '密码重置成功' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/delete-account', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isValidEmail(email)) {
      const error = new Error('请提供有效邮箱');
      error.status = 400;
      throw error;
    }
    const users = await readUsers();
    const hasUser = users.some((item) => item.email === email);
    if (!hasUser) {
      const error = new Error('账号不存在或已删除');
      error.status = 404;
      throw error;
    }
    const usersAfterDelete = users.filter((item) => item.email !== email && item.email !== `__register_code__:${email}`);
    await writeUsers(usersAfterDelete);
    res.json({ ok: true, message: '账号已注销，后台数据已清除' });
  } catch (error) {
    next(error);
  }
});

app.post('/api/focus', async (req, res, next) => {
  try {
    const { materialText = '', notes = '' } = req.body;
    const input = `复习资料：\n${limitText(materialText)}\n\n补充笔记：\n${limitText(notes, 2000)}`;
    const data = await askAI(
      '你是一位服务中国大学生的考试辅导 AI。请严格“基于资料内容”总结高频考点，禁止泛化空话。每个高频考点必须是资料里真实出现或可直接归纳出的内容，并提供详细解释说明。必须包含：概念定义、核心机制/原理、常见考法、易错陷阱、典型例子、快速记忆法。reason 字段要说明“为什么这是高频考点（结合资料）”。若资料信息不足必须写“资料未覆盖”。输出中文、JSON、结构化。',
      input,
      '{"highFrequencyTopics":[{"title":"","star":1,"reason":"","definition":"","corePrinciples":[""],"examAngles":[""],"commonTraps":[""],"examples":[""],"memoryHook":""}],"knowledgeStructure":[{"chapter":"","points":[""]}],"predictions":[{"title":"","confidence":"高/中/低","why":""}],"summary":""}'
    );
    res.json(normalizeFocusResult(data));
  } catch (error) {
    next(error);
  }
});

app.post('/api/cards', async (req, res, next) => {
  try {
    const { materialText = '', focus = null } = req.body;
    const input = `资料：\n${limitText(materialText)}\n\n重点提炼结果：\n${limitText(safeStringify(focus), 8000)}`;
    let data = await askAI(
      '你是一位擅长考前速记设计的 AI。请只提取这份资料“最重要、最可能考、最值得最后记住”的内容，不要全面覆盖。cheatSheet 最多 5 条，每条 bullets 最多 4 条，句子短、可直接背诵。',
      input,
      '{"cheatSheet":[{"title":"","bullets":[""]}],"conceptCards":[{"term":"","explanation":"","memoryHook":""}],"lastMinuteChecklist":[""]}'
    );
    if (Array.isArray(data.cheatSheet)) {
      data.cheatSheet = data.cheatSheet.slice(0, 5).map((item) => ({
        ...item,
        bullets: Array.isArray(item.bullets) ? item.bullets.slice(0, 4) : [],
      }));
    }
    if (Array.isArray(data.conceptCards)) {
      data.conceptCards = data.conceptCards.slice(0, 5);
    }
    if (Array.isArray(data.lastMinuteChecklist)) {
      data.lastMinuteChecklist = data.lastMinuteChecklist.slice(0, 8);
    }
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.post('/api/quiz', async (req, res, next) => {
  try {
    const { materialText = '', chapter = '全部章节', difficulty = '中等', count = 6 } = req.body;
    const input = `资料：\n${materialText}\n\n按以下要求出题：章节=${chapter}；难度=${difficulty}；总数=${count}。题型必须同时包含选择题、简答题、论述题。`;
    const data = await askAI(
      '你是一位命题老师。请基于资料动态生成题目，不要脱离资料，不要输出题库式废话。每题都要提供参考答案和评分点。',
      input,
      '{"questions":[{"id":"q1","type":"选择题/简答题/论述题","chapter":"","difficulty":"","question":"","options":["A"],"answer":"","rubric":[""],"points":[""]}]}'
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.post('/api/analyze-answers', async (req, res, next) => {
  try {
    const { questions = [], answers = [], materialText = '' } = req.body;
    const input = `资料：\n${materialText}\n\n题目：\n${JSON.stringify(questions, null, 2)}\n\n用户答案：\n${JSON.stringify(answers, null, 2)}`;
    const data = await askAI(
      '你是一位考试诊断 AI。请判断作答情况，并明确错误原因属于概念错误、理解错误还是记忆错误，同时给出对应知识点和复习建议。',
      input,
      '{"results":[{"id":"","score":0,"verdict":"正确/部分正确/错误","analysisType":"概念/理解/记忆","matchedKnowledge":"","whyWrong":"","reviewAdvice":""}],"overallAdvice":""}'
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.post('/api/plan', async (req, res, next) => {
  try {
    const { daysLeft = 7, focus = null, weakPoints = [] } = req.body;
    const input = `距离考试 ${daysLeft} 天。重点信息：\n${limitText(safeStringify(focus), 8000)}\n\n薄弱点：\n${limitText(safeStringify(weakPoints, '[]'), 4000)}`;
    const data = await askAI(
      '你是一位经验丰富的学习规划师。请严格根据距离考试天数生成逐日冲刺计划：day 数量应与 daysLeft 一致（当 daysLeft<=0 时按 1 天冲刺）。每一天都要细化到可执行层面，至少包含：当日主题、分时段任务（上午/下午/晚上）、每个任务的目标产出、刷题数量目标、复盘检查点、优先级。阶段上要体现“前期打基础-中期强化-后期模考冲刺”的节奏，并结合薄弱点做针对安排。输出中文，避免空话。',
      input,
      '{"days":[{"day":1,"theme":"","timeBlocks":[{"period":"上午/下午/晚上","tasks":[""],"deliverables":[""]}],"tasks":[""],"questionTarget":"","checkpoint":"","priority":"高/中/低"}],"strategy":""}'
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const message = String(req.body?.message || '').trim();
    const materialName = String(req.body?.materialName || '').trim();
    const materialText = limitText(String(req.body?.materialText || ''), 8000);
    const notes = limitText(String(req.body?.notes || ''), 2000);
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];

    if (!message) {
      const error = new Error('请输入想咨询的问题');
      error.status = 400;
      throw error;
    }

    const historyText = history
      .map((item) => `${item?.role === 'assistant' ? 'AI' : '用户'}：${String(item?.content || '')}`)
      .join('\n');
    const nowLabel = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    const contextBlock = [
      `当前日期时间：${nowLabel}（北京时间 UTC+8，回答日期、星期、时间类问题时以此为准）`,
      materialName ? `当前资料名：${materialName}` : '当前资料名：未选择',
      notes ? `老师补充笔记：\n${notes}` : '老师补充笔记：无',
      materialText ? `当前资料内容摘录：\n${materialText}` : '当前资料内容摘录：无',
      historyText ? `最近对话：\n${historyText}` : '最近对话：无',
      `用户当前提问：${message}`,
    ].join('\n\n');

    const answer = await askAIPlainText(
      '你是”AI期末复习助手”的智能学习助教，服务中国大学生。请用中文直接、完整地回答用户问题：\n'
      + '1. 问题与当前资料相关时，优先基于资料内容回答，并指出对应知识点；若资料中确实缺少依据，可简要说明”资料未覆盖此点”，再结合通用知识补全答案。\n'
      + '2. 问题与资料无关时（如学科概念、作业题、学习方法、考试技巧等），直接利用你的知识给出准确、可用的答案，不要输出思考过程或只给框架，不要强调”资料未覆盖”。\n'
      + '3. 回答尽量结构化、便于复习，不要输出 JSON。',
      contextBlock,
    );
    res.json({ answer });
  } catch (error) {
    next(error);
  }
});

const distDir = path.resolve(process.cwd(), 'dist');
app.use(express.static(distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    next();
    return;
  }
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) next(err);
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ message: '接口不存在' });
    return;
  }
  res.status(404).send('Not found');
});

app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ message: error.message || '服务异常，请稍后重试' });
});

const server = app.listen(port, async () => {
  console.log(`AI review server listening on http://localhost:${port}`);
  try {
    await fs.access(path.join(distDir, 'index.html'));
    console.log('前端已就绪：在浏览器打开上述地址即可使用（需已执行 npm run build）。');
  } catch {
    console.log('未找到 dist/index.html：开发请运行 npm run dev，并打开 Vite 提示的本地地址（一般为 http://localhost:5173）。');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用。请关闭占用该端口的程序，或在 .env 中将 PORT 改为其他端口后再启动。`);
    process.exit(1);
    return;
  }
  console.error(err);
  process.exit(1);
});
