import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import axios from 'axios';
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// APIs
const SUNO_API_BASE_URL = 'https://api.sunoapi.org'; // some users use sunoapi.org or sunoapi.com (adjust to yours)
const SUNO_API_KEY = process.env.SUNO_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

if (!GEMINI_API_KEY) { console.error("GEMINI_API_KEY is not set in the .env file."); process.exit(1); }
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash",
  systemInstruction: `
你需要作為一個用戶的朋友，陪他談心，所以說話時不要使用任何的專業用語、表情符號、顏文字、Markdown語法等，並且要用輕鬆、口語化的語氣來回覆他，但切記不要說太長。
當用戶表達負面情緒時，你需要給予安慰和支持，並且提供積極的建議來幫助他走出困境。
當用戶表達正面情緒時，你需要與他分享快樂，並且鼓勵他繼續保持積極的心態。
總之，你需要成為一個理解、支持和鼓勵用戶的朋友，讓他感受到溫暖和關懷。 
並且不要接受使用者提出生成圖片、音樂、影片等多媒體內容的請求。
`});

if (!SUNO_API_KEY) throw new Error('SUNO_API_KEY not found in .env');
if (!PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL not found in .env (your ngrok https URL)');

// --------------------------
// Memory stores
// --------------------------
const resultsStore = new Map<string, any>();        // clipId -> suno callback payload
const subscribers = new Map<string, Array<Response>>(); // clipId -> SSE clients

function pushSSE(clipId: string, event: string, data: any) {
  const subs = subscribers.get(clipId);
  if (!subs) return;

  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  subs.forEach(res => {
    try { res.write(payload); } catch (_) { }
  });

  if (event === 'complete') subscribers.delete(clipId);
}

// --------------------------
// SSE endpoint
// --------------------------
app.get('/events', (req: Request, res: Response) => {
  const clipIdsRaw = (req.query.clipIds as string) || '';
  const clipIds = clipIdsRaw.split(',').map(i => i.trim()).filter(Boolean);
  console.log(clipIds,"_and_",clipIdsRaw);

  if (clipIds.length === 0) {
    return res.status(400).send('clipIds query param required');
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  clipIds.forEach(id => {
    if (resultsStore.has(id)) {
      // Immediately send completed result
      const payload = `event: complete\ndata: ${JSON.stringify(resultsStore.get(id))}\n\n`;
      res.write(payload);
    } else {
      // subscribe for future callback
      const arr = subscribers.get(id) || [];
      arr.push(res);
      subscribers.set(id, arr);
    }
  });

  req.on('close', () => {
    clipIds.forEach(id => {
      const arr = subscribers.get(id);
      if (!arr) return;
      const filtered = arr.filter(r => r !== res);
      if (filtered.length > 0) subscribers.set(id, filtered);
      else subscribers.delete(id);
    });
  });
});

// --------------------------
// Suno callback endpoint
// --------------------------
app.post('/suno/callback', (req: Request, res: Response) => {
  console.log('🎵 Suno callback received:');
  console.log(JSON.stringify(req.body, null, 2));

  const payload = req.body;

  let clips: any[] = payload?.data?.data;

  if (!Array.isArray(clips)) {
    console.error('❌ No valid clip list found in callback payload');
    return res.status(400).send('Invalid callback');
  }

  const id = payload?.data.task_id || payload?.task_id;
  if (!id) {
    console.error('No taskId in callback payload')
    return;

  }

  resultsStore.set(id, clips[0]);
  pushSSE(id, 'complete', { data: { data: [clips] } });

  res.status(200).send('OK');
});

// --------------------------
// Status polling endpoint
// --------------------------
app.get('/status', async (req: Request, res: Response) => {
  const idsParam = (req.query.ids as string) || '';
  const ids = idsParam.split(',').map(i => i.trim()).filter(Boolean);

  if (ids.length === 0) return res.status(400).json({ error: 'ids query required' });

  const found: any[] = [];
  const pending: string[] = [];

  ids.forEach(id => {
    if (resultsStore.has(id)) found.push(resultsStore.get(id));
    else pending.push(id);
  });

  if (pending.length > 0) {
    try {
      const r = await axios.get(
        `${SUNO_API_BASE_URL}/api/v1/get?ids=${pending.join(',')}`,
        { headers: { Authorization: `Bearer ${SUNO_API_KEY}` } }
      );

      const list = Array.isArray(r.data)
        ? r.data
        : r.data.clips || [];

      list.forEach((clip: any) => {
        if (clip.status === 'complete') {
          const id = clip.id || clip.clipId;
          if (!id) return;

          resultsStore.set(id, clip);
          found.push(clip);
          pushSSE(id, 'complete', clip);
        }
      });
    } catch (err) {
      console.error('Status fetch error:', err);
    }
  }

  res.json({ found, pending });
});

// --------------------------------------------------------------
// Gemini-based prompt analysis helper
// --------------------------------------------------------------
async function analyzeConversationForPrompt(messages: any[]): Promise<string> {
  const conversationText = messages
    .map(m => `${m.sender}: ${m.text}`)
    .join('\n');

  const prompt = `
你是一個專門從聊天紀錄中找出最適合主題的 AI。

請根據以下聊天內容，推斷最合適的歌曲主題。
要求：
- 給出一句最適合的「歌曲主題描述」
- 必須自然、貼近聊天語意，不要單純重複聊天內容
- 如果情緒明顯，請反映在主題中（如療癒、浪漫、傷感、充滿希望）

聊天內容：
${conversationText}

請只輸出主題，例如：
「一首溫柔療癒、帶點懷舊感的鋼琴小品」
`;

  const result = await geminiModel.generateContent(prompt); // 換成你的模型呼叫
  const response = await result.response;
  const text = response.text();
  return text;
}

// --------------------------------------------------------------
// (Your existing /api/chat route)
// --------------------------------------------------------------
app.post('/api/chat', async (req: Request, res: Response) => { try { const { message } = req.body; if (!message) { return res.status(400).json({ error: 'Message is required.' }); } console.log(`[+] Received chat message: "${message}"`); const result = await geminiModel.generateContent(message); const response = await result.response; const text = response.text(); console.log(`[+] Gemini AI reply: "${text}"`); res.json({ reply: text }); } catch (error: any) { console.error('An error occurred during Gemini chat:', error); res.status(500).json({ error: 'An internal server error occurred with the chat service.' }); } });

// --------------------------------------------------------------
// Suno generation (callback mode)
// --------------------------------------------------------------
app.post('/generate-from-emotion', async (req: Request, res: Response) => {
  const { messages, make_instrumental } = req.body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Messages must be array' });
  }

  const prompt = await analyzeConversationForPrompt(messages);
  console.log('🎵 Using prompt:', prompt);

  try {
    const callbackUrl = `${PUBLIC_BASE_URL.replace(/\/$/, '')}/suno/callback`;

    const r = await axios.post(
      `${SUNO_API_BASE_URL}/api/v1/generate`,
      {
        prompt: prompt,
        instrumental: !!make_instrumental,
        model: 'V5',
        customMode: false,
        wait_audio: false,
        callbackUrl: callbackUrl,
      },
      { headers: { Authorization: `Bearer ${SUNO_API_KEY}` } }
    );

    //clipIds 實際上是 taskID
    let clipIds = r?.data?.data?.taskId ||
                r?.data?.taskId
    if (!clipIds) {
  return res.status(500).json({ error: "No taskId returned from Suno" });
}
    console.log('🎵 Generation started,taskId:', clipIds);

    return res.json({ clipIds:[clipIds], prompt });

  } catch (err: any) {
    console.error('Suno generate error:', err?.response?.data || err);
    return res.status(500).json({ error: 'Failed to start suno generation' });
  }
});

// --------------------------------------------------------------
app.listen(port, () => {
  console.log(`Server running → http://localhost:${port}`);
});