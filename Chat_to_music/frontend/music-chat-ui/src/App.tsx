import { useState, type FormEvent, useRef, useEffect } from 'react';

// --- React App Component ---

interface Message {
  text: string;
  sender: 'user' | 'bot';
  audioUrl?: string; // To hold the URL of the generated music
}

function App() {
  // Chat state
  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);

  // Music generation state
  const [isInstrumental, setIsInstrumental] = useState(false);
  const [isGeneratingMusic, setIsGeneratingMusic] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleGenerateMusicFromEmotion = async () => {
    if (isChatLoading || isGeneratingMusic) return;

    const userMessage: Message = {
      text: `(Requesting music based on our conversation...)`,
      sender: 'user',
    };
    setMessages(prev => [...prev, userMessage]);
    setIsGeneratingMusic(true);

    try {
      const resp = await fetch('http://localhost:3001/generate-from-emotion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messages,
          make_instrumental: isInstrumental,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to start generation');
      }

      const data = await resp.json();
      const clipIds: string[] = data.clipIds || [];

      if (!clipIds || clipIds.length === 0) {
        throw new Error('No clip IDs returned from server.');
      }

      // subscribe to SSE for these clipIds
      const sseUrl = `http://localhost:3001/events?clipIds=${encodeURIComponent(clipIds.join(','))}`;
      const es = new EventSource(sseUrl);

      // safety: a timeout to fallback to polling if SSE fails/never returns
      const SSE_TIMEOUT = 120_000; // 120s
      let sseTimeout = window.setTimeout(() => {
        console.warn('SSE timeout, will fallback to polling /status');
        es.close();
        fallbackPoll(clipIds);
      }, SSE_TIMEOUT);

      es.addEventListener('complete', (ev: MessageEvent) => {
        try {
          clearTimeout(sseTimeout);
          const payload = JSON.parse(ev.data);
          console.log('SSE complete payload:', payload);
          // 真正 clips
          const clips = payload?.data?.data;
          console.log('SSE complete clips:', clips);
          if (!Array.isArray(clips) || clips.length === 0) return;

          const clip = clips[0][0]; // 第一首
          console.log('SSE complete clip:', clip);

          const botMessage: Message = {
            text: `我為你創作了這首歌: "${clip.title || clip.id}"`,
            sender: 'bot',
            audioUrl: clip.stream_audio_url + ".mp3"
          };
          setMessages(prev => [...prev, botMessage]);
        } catch (e) {
          console.error('Error parsing SSE complete payload', e);
        } finally {
          es.close();
          setIsGeneratingMusic(false);
        }
      });

      es.onerror = (err) => {
        console.error('SSE error', err);
        // don't immediately stop; fallback after timeout will handle
      };

      // fallback polling function
      async function fallbackPoll(ids: string[]) {
        const maxAttempts = 30; // e.g., 30 attempts
        let attempts = 0;
        const pollInterval = 5000;
        while (attempts < maxAttempts) {
          try {
            const s = await fetch(`http://localhost:3001/status?ids=${encodeURIComponent(ids.join(','))}`);
            if (s.ok) {
              const json = await s.json();
              if (json.found && json.found.length > 0) {
                json.found.forEach((clip: any) => {
                  const botMessage: Message = {
                    text: `我為你創作了這首歌: "${clip.title || clip.id || 'Generated clip'}"`,
                    sender: 'bot',
                    audioUrl: clip.audio_url || clip.audioUrl || clip.audio || clip.download_url || clip.file_url || clip.url,
                  };
                  setMessages(prev => [...prev, botMessage]);
                });
                setIsGeneratingMusic(false);
                return;
              }
            }
          } catch (e) {
            console.error('poll error', e);
          }
          attempts++;
          await new Promise(r => setTimeout(r, pollInterval));
        }
        // timed out
        setMessages(prev => [...prev, { text: 'Generation timed out. Please try again.', sender: 'bot' }]);
        setIsGeneratingMusic(false);
      }

    } catch (error) {
      console.error('Error generating music:', error);
      const msgText = error instanceof Error ? error.message : 'Error generating music';
      setMessages(prev => [...prev, { text: msgText, sender: 'bot' }]);
      setIsGeneratingMusic(false);
    }
  };

  const handleChatSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!inputValue.trim() || isChatLoading || isGeneratingMusic) return;

    const userMessage: Message = { text: inputValue, sender: 'user' };
    setMessages((prevMessages) => [...prevMessages, userMessage]);
    const currentInput = inputValue;
    setInputValue('');
    setIsChatLoading(true);

    try {
      const response = await fetch('http://localhost:3001/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: currentInput }),
      });

      if (!response.ok) {
        throw new Error('Network response was not ok');
      }

      const data = await response.json();
      const botMessage: Message = { text: data.reply, sender: 'bot' };
      setMessages((prevMessages) => [...prevMessages, botMessage]);

    } catch (error) {
      console.error('Error fetching chat response:', error);
      const errorMessage: Message = { text: 'Sorry, I am having trouble connecting.', sender: 'bot' };
      setMessages((prevMessages) => [...prevMessages, errorMessage]);
    } finally {
      setIsChatLoading(false);
    }
  };

  return (
    <div className="container">
      <header>
        <h1>不掃興樂團</h1>
      </header>

      <main>
        <div className="chat-container">
          {messages.map((msg, index) => (
            <div key={index} className={`chat-message ${msg.sender === 'user' ? 'user' : 'ai'}`}>
              <div className="message-bubble">
                <p className={msg.text.startsWith('(Requesting') ? 'italic' : ''}>{msg.text}</p>
                {msg.audioUrl && (
                  // <audio controls preload="auto">
                  //   <source src = {msg.audioUrl} type="audio/mpeg"/>
                  //     您的瀏覽器不支援 audio。
                  // </audio>
                  // 這段因為剛生成的音樂連結跨域有CORS問題，改成連結
                  <a href={msg.audioUrl} target="_blank" rel="noopener noreferrer">
                    音樂連結
                  </a>
                )}
              </div>
            </div>
          ))}

          {(isChatLoading || isGeneratingMusic) && (
            <div className="loading-message">
              <div className="bubble">
                {isGeneratingMusic ? 'Creating music based on our vibe...' : '...'}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </main>

      <footer>
        <form onSubmit={handleChatSubmit}>
          <input
            type="text"
            placeholder="輸入你的訊息..."
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            disabled={isChatLoading || isGeneratingMusic}
          />
          <button
            type="submit"
            disabled={isChatLoading || isGeneratingMusic || !inputValue}
            className="send-button"
          >
            ✉️
          </button>
          <button
            type="button"
            onClick={handleGenerateMusicFromEmotion}
            disabled={isGeneratingMusic || isChatLoading || messages.length <= 1}
            className="music-button"
          >
            🎵
          </button>
        </form>

        <div className="checkbox-container">
          <label>
            <input
              type="checkbox"
              checked={isInstrumental}
              onChange={(e) => setIsInstrumental(e.target.checked)}
              disabled={isGeneratingMusic || isChatLoading}
            />
            <span>Instrumental Only</span>
          </label>
        </div>
      </footer>
    </div>
  );
}

export default App;