import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import JSZip from 'jszip';

export function normalizeUploadedFilename(name = '') {
  if (!name) return '';
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  const hasCjk = /[\u3400-\u9fff]/.test(decoded);
  const looksBroken = /[ÃÂÅÆÇÐÑÕÖØÜÝÞßà-ÿ]/.test(name) || name.includes('�');
  return hasCjk || looksBroken ? decoded : name;
}

function stripXml(xml = '') {
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function readPdf(buffer) {
  const data = await pdfParse(buffer);
  return data.text?.trim() || '';
}

async function readDocx(buffer) {
  const data = await mammoth.extractRawText({ buffer });
  return data.value?.trim() || '';
}

async function readPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const texts = [];
  for (const fileName of slideFiles) {
    const xml = await zip.file(fileName)?.async('string');
    if (xml) texts.push(stripXml(xml));
  }
  return texts.join('\n').trim();
}

export async function extractFileText(file) {
  const originalName = normalizeUploadedFilename(file.originalname || '');
  const name = originalName.toLowerCase();
  const type = file.mimetype || '';

  if (name.endsWith('.pdf') || type.includes('pdf')) return readPdf(file.buffer);
  if (name.endsWith('.docx') || type.includes('wordprocessingml')) return readDocx(file.buffer);
  if (name.endsWith('.pptx') || type.includes('presentationml')) return readPptx(file.buffer);
  if (name.endsWith('.txt') || name.endsWith('.md') || type.startsWith('text/')) return file.buffer.toString('utf-8');

  throw new Error(`暂不支持的文件类型：${originalName}`);
}
