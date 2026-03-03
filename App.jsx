import React, { useState, useEffect, useRef } from 'react';
import { 
  Menu, X, Plus, MessageSquare, LayoutDashboard, Send, 
  Brain, ShieldAlert, Sparkles, BookOpen, UserCircle, Settings,
  Loader2, Lightbulb, ChevronRight, AlertTriangle
} from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, signInWithCustomToken, signInAnonymously, onAuthStateChanged 
} from 'firebase/auth';
import { 
  getFirestore, collection, doc, setDoc, onSnapshot, serverTimestamp, deleteDoc 
} from 'firebase/firestore';

// --- Configuration & Initialization ---
const apiKey = ""; // Provided by execution environment
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

// Firebase Setup
let app, auth, db, appId;
try {
  const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  appId = typeof __app_id !== 'undefined' ? __app_id : 'educational-bot-default';
} catch (e) {
  console.error("Firebase initialization error:", e);
}

// --- AI Service ---
const generateAIResponse = async (messages, mode, userProfileText = "") => {
  const modeInstructions = {
    standard: "CURRENT MODE: STANDARD. Provide direct, concise responses (2-4 sentences max). Offer quick clarifications on misconceptions with simple reasoning.",
    extended: "CURRENT MODE: EXTENDED. Provide detailed, comprehensive explanations (2-3 paragraphs). Include multi-step breakdowns, supporting evidence, examples, and counterarguments.",
    agents: "CURRENT MODE: AI AGENTS. Provide a multi-perspective analysis (3-5 paragraphs). Roleplay as different expert personas (scientist, philosopher, historian, etc.). Present multiple viewpoints and challenge assumptions from different angles."
  };

  const systemInstruction = `
You are EducationalBot, an advanced educational AI assistant designed to help students (ages 13+) identify cognitive biases, misconceptions, and delusional thinking patterns.
Your tone MUST be supportive, non-judgmental, encouraging, and family-friendly. Never mock or demean the student.

${modeInstructions[mode]}

CRITICAL RESPONSE FRAMEWORK:
Unless the user is just saying a basic greeting, you MUST structure your response using EXACTLY these headings in bold. Do not deviate from this format for educational answers:

**Acknowledgment:** [Validate what the student said and their curiosity]
**The Misconception:** [Clearly identify what might be incorrect or biased]
**The Reality:** [Present evidence-based truth]
**Why the Confusion:** [Explain how this misconception commonly arises]
**Deeper Insight:** [Provide critical thinking tools or context]
**Reflection Question:** [Ask a question to encourage self-examination]

RED FLAGS TO ADDRESS (Gently but firmly correct): Conspiracy theories, false causation, appeal to authority, confirmation bias, logical fallacies, pseudoscience.
SAFETY: Refuse requests violating safety policies, no harm, no hate.
  `;

  // Format history for Gemini
  const formattedHistory = messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.text }]
  }));

  const payload = {
    contents: formattedHistory,
    systemInstruction: { parts: [{ text: systemInstruction }] }
  };

  // Exponential backoff retry logic
  const maxRetries = 5;
  const delays = [1000, 2000, 4000, 8000, 16000];
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(GEMINI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || "I'm having trouble thinking right now. Could you ask that again?";
    } catch (error) {
      if (i === maxRetries - 1) return "I apologize, but I am experiencing connection issues. Please try again later.";
      await new Promise(res => setTimeout(res, delays[i]));
    }
  }
};

// NEW: ✨ Feature 1 - Auto Chat Titling
const generateChatTitle = async (message) => {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: `Generate a short, engaging title (maximum 5 words) for an educational chat starting with this question/statement: "${message}". Respond ONLY with the title, no quotes or extra text.` }] }]
  };
  try {
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.replace(/["']/g, '') || "New Session";
  } catch (e) {
    return "New Session";
  }
};

// NEW: ✨ Feature 2 - AI Thinking Profile Analysis
const generateLearningAnalysis = async (chats) => {
  // Extract user queries from recent chats
  const userMessages = chats.flatMap(c => 
    (c.messages || []).filter(m => m.role === 'user').map(m => m.text)
  ).slice(-50); 

  if (userMessages.length === 0) return "Not enough data to analyze yet. Keep chatting to build your profile!";

  const prompt = `You are EducationalBot's AI Analyst. Analyze these recent topics the student has explored and provide a 3-paragraph "Thinking Profile" report.
  Include these exact sections:
  **1. Curiosity Profile:** What themes are they drawn to?
  **2. Cognitive Patterns:** What types of biases or misconceptions might they be grappling with based on these questions?
  **3. Next Steps:** A specific, personalized recommendation for a topic they should explore next to improve their critical thinking.
  
  Student's recent queries:
  ${JSON.stringify(userMessages)}`;

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }]
  };
  
  try {
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "Unable to generate analysis at this time.";
  } catch (e) {
    return "Error analyzing progress. Please try again later.";
  }
};

// --- Main Application Component ---
export default function App() {
  // State
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState('chat'); // 'chat' | 'dashboard'
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  // Data State
  const [chats, setChats] = useState([]);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [mode, setMode] = useState('extended'); // 'standard' | 'extended' | 'agents'
  
  // Input State
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);

  // ✨ Analysis State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisReport, setAnalysisReport] = useState(null);

  // 1. Initialize Auth
  useEffect(() => {
    if (!auth) {
      setAuthLoading(false);
      return;
    }

    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error("Authentication failed:", error);
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // 2. Fetch User Chats
  useEffect(() => {
    if (!user || !db) return;

    const chatsRef = collection(db, 'artifacts', appId, 'users', user.uid, 'chats');
    const unsubscribe = onSnapshot(chatsRef, (snapshot) => {
      const fetchedChats = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      // Sort in memory per Rule 2
      fetchedChats.sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0));
      setChats(fetchedChats);
      
      // If we have a current chat, update its messages from the remote state
      if (currentChatId) {
        const activeChat = fetchedChats.find(c => c.id === currentChatId);
        if (activeChat) setMessages(activeChat.messages || []);
      }
    }, (error) => {
      console.error("Error fetching chats:", error);
    });

    return () => unsubscribe();
  }, [user, currentChatId]);

  // Scroll to bottom of chat
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // --- Handlers ---
  const handleNewChat = () => {
    setCurrentChatId(null);
    setMessages([]);
    setView('chat');
    // On mobile, close sidebar after selecting
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleSelectChat = (chatId) => {
    setCurrentChatId(chatId);
    const selectedChat = chats.find(c => c.id === chatId);
    if (selectedChat) {
      setMessages(selectedChat.messages || []);
      setMode(selectedChat.mode || 'extended');
    }
    setView('chat');
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const handleAnalyzeProgress = async () => {
    setIsAnalyzing(true);
    const report = await generateLearningAnalysis(chats);
    setAnalysisReport(report);
    setIsAnalyzing(false);
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!input.trim() || !user) return;

    const userMessage = { role: 'user', text: input.trim(), timestamp: Date.now() };
    const newMessages = [...messages, userMessage];
    
    setInput('');
    setMessages(newMessages);
    setIsTyping(true);

    let activeChatId = currentChatId;

    // Create new chat doc if it doesn't exist
    if (!activeChatId) {
      activeChatId = `chat_${Date.now()}`;
      setCurrentChatId(activeChatId);
      
      // Temporary title while generating a better one
      const tempTitle = userMessage.text.slice(0, 30) + (userMessage.text.length > 30 ? '...' : '');
      
      await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'chats', activeChatId), {
        title: tempTitle,
        mode: mode,
        messages: newMessages,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp()
      });

      // ✨ Auto-generate better title in background
      generateChatTitle(userMessage.text).then(async (aiTitle) => {
        await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'chats', activeChatId), {
          title: aiTitle
        }, { merge: true });
      });

    } else {
      // Update existing chat immediately with user message
      await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'chats', activeChatId), {
        messages: newMessages,
        updatedAt: serverTimestamp(),
        mode: mode // update mode in case it changed
      }, { merge: true });
    }

    // Call AI
    const aiResponseText = await generateAIResponse(newMessages, mode);
    
    const finalMessages = [...newMessages, { role: 'model', text: aiResponseText, timestamp: Date.now() }];
    setMessages(finalMessages);
    setIsTyping(false);

    // Save final messages
    await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'chats', activeChatId), {
      messages: finalMessages,
      updatedAt: serverTimestamp()
    }, { merge: true });
  };

  // --- UI Renderers ---

  const renderFormattedText = (text) => {
    // A simple parser to make the framework headings look nice
    const sections = text.split(/(?=\*\*(?:Acknowledgment|The Misconception|The Reality|Why the Confusion|Deeper Insight|Reflection Question):\*\*)/i);
    
    if (sections.length <= 1) {
      // Standard text without framework
      return <div className="whitespace-pre-wrap text-slate-700 leading-relaxed">{text}</div>;
    }

    return (
      <div className="space-y-4">
        {sections.map((section, idx) => {
          if (!section.trim()) return null;
          
          const match = section.match(/^\*\*(.*?):\*\*(.*)/s);
          if (match) {
            const [, title, content] = match;
            let bgColor = "bg-white";
            let icon = <ChevronRight className="w-5 h-5" />;
            
            if (title.includes("Misconception")) { bgColor = "bg-red-50 border-red-100"; icon = <AlertTriangle className="w-5 h-5 text-red-500" />; }
            else if (title.includes("Reality")) { bgColor = "bg-green-50 border-green-100"; icon = <Brain className="w-5 h-5 text-green-600" />; }
            else if (title.includes("Confusion")) { bgColor = "bg-orange-50 border-orange-100"; icon = <ShieldAlert className="w-5 h-5 text-orange-500" />; }
            else if (title.includes("Insight")) { bgColor = "bg-blue-50 border-blue-100"; icon = <Sparkles className="w-5 h-5 text-blue-500" />; }
            else if (title.includes("Reflection")) { bgColor = "bg-purple-50 border-purple-100"; icon = <Lightbulb className="w-5 h-5 text-purple-500" />; }
            
            return (
              <div key={idx} className={`p-4 rounded-xl border ${bgColor} shadow-sm transition-all hover:shadow-md`}>
                <div className="flex items-center gap-2 mb-2 font-semibold text-slate-800">
                  {icon}
                  <span>{title}</span>
                </div>
                <div className="text-slate-700 leading-relaxed ml-7">
                  {content.trim()}
                </div>
              </div>
            );
          }
          // Fallback for text outside of matched sections
          return <div key={idx} className="whitespace-pre-wrap text-slate-700 leading-relaxed">{section}</div>;
        })}
      </div>
    );
  };

  if (authLoading) {
    return <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-500"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }

  return (
    <div className="flex h-screen bg-slate-50 font-sans overflow-hidden">
      
      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-slate-900/20 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`
        fixed md:static inset-y-0 left-0 z-30
        w-72 bg-white border-r border-slate-200 flex flex-col transition-transform duration-300 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
      `}>
        <div className="p-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2 text-indigo-600 font-bold text-xl tracking-tight">
            <Brain className="w-6 h-6" />
            EducationalBot
          </div>
          <button className="md:hidden text-slate-400 hover:text-slate-600" onClick={() => setSidebarOpen(false)}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-3">
          <button 
            onClick={handleNewChat}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-lg font-medium transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New Session
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 ml-2 mt-2">Recent Sessions</div>
          {chats.length === 0 && (
            <div className="text-sm text-slate-400 text-center py-4">No sessions yet.</div>
          )}
          {chats.map(chat => (
            <button
              key={chat.id}
              onClick={() => handleSelectChat(chat.id)}
              className={`w-full text-left px-3 py-2.5 rounded-lg flex items-center gap-3 transition-colors ${currentChatId === chat.id && view === 'chat' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              <MessageSquare className={`w-4 h-4 shrink-0 ${currentChatId === chat.id && view === 'chat' ? 'text-indigo-600' : 'text-slate-400'}`} />
              <span className="truncate text-sm">{chat.title}</span>
            </button>
          ))}
        </div>

        <div className="p-3 border-t border-slate-100">
          <button 
            onClick={() => { setView('dashboard'); if(window.innerWidth < 768) setSidebarOpen(false); }}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${view === 'dashboard' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            <LayoutDashboard className="w-5 h-5" />
            Learning Dashboard
          </button>
          <div className="mt-2 flex items-center gap-3 px-3 py-2.5 text-sm text-slate-500">
            <UserCircle className="w-5 h-5" />
            <span className="truncate">Student ID: {user?.uid?.substring(0,6)}...</span>
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#f8fafc]">
        
        {/* Header */}
        <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shrink-0 shadow-sm z-10">
          <div className="flex items-center gap-3">
            <button className="md:hidden text-slate-500 hover:text-slate-700 p-1" onClick={() => setSidebarOpen(true)}>
              <Menu className="w-6 h-6" />
            </button>
            <h1 className="font-semibold text-slate-800 text-lg">
              {view === 'dashboard' ? 'Learning Dashboard' : 'Active Session'}
            </h1>
          </div>

          {view === 'chat' && (
            <div className="flex bg-slate-100 p-1 rounded-lg">
              {['standard', 'extended', 'agents'].map(m => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-all duration-200 ${mode === m ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </header>

        {/* View Routing */}
        {view === 'dashboard' ? (
          <div className="flex-1 overflow-y-auto p-6 md:p-8">
            <div className="max-w-4xl mx-auto">
              <h2 className="text-2xl font-bold text-slate-800 mb-6">Your Progress</h2>
              
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
                  <div className="bg-blue-100 p-3 rounded-xl text-blue-600"><BookOpen className="w-6 h-6" /></div>
                  <div>
                    <div className="text-2xl font-bold text-slate-800">{chats.length}</div>
                    <div className="text-sm text-slate-500 font-medium">Sessions Explored</div>
                  </div>
                </div>
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
                  <div className="bg-green-100 p-3 rounded-xl text-green-600"><ShieldAlert className="w-6 h-6" /></div>
                  <div>
                    <div className="text-2xl font-bold text-slate-800">{chats.reduce((acc, chat) => acc + (chat.messages?.length || 0), 0)}</div>
                    <div className="text-sm text-slate-500 font-medium">Interactions</div>
                  </div>
                </div>
                <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
                  <div className="bg-purple-100 p-3 rounded-xl text-purple-600"><Sparkles className="w-6 h-6" /></div>
                  <div>
                    <div className="text-2xl font-bold text-slate-800">Level 1</div>
                    <div className="text-sm text-slate-500 font-medium">Critical Thinker</div>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                <h3 className="text-lg font-semibold text-slate-800 mb-4 flex items-center gap-2">
                  <Brain className="w-5 h-5 text-indigo-500" />
                  Recent Topics
                </h3>
                <div className="space-y-3">
                  {chats.slice(0, 5).map(chat => (
                    <div key={chat.id} className="p-4 rounded-xl bg-slate-50 border border-slate-100 flex justify-between items-center cursor-pointer hover:bg-slate-100 transition" onClick={() => handleSelectChat(chat.id)}>
                      <span className="font-medium text-slate-700">{chat.title}</span>
                      <span className="text-xs font-semibold px-2 py-1 bg-white border rounded text-slate-500 capitalize">{chat.mode || 'extended'}</span>
                    </div>
                  ))}
                  {chats.length === 0 && <p className="text-slate-500 text-sm">Start a chat to see your history here.</p>}
                </div>
              </div>

              {/* ✨ AI Analysis Feature */}
              <div className="mt-8 bg-gradient-to-br from-indigo-50 to-purple-50 rounded-2xl shadow-sm border border-indigo-100 p-6">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
                  <div>
                    <h3 className="text-lg font-semibold text-indigo-900 flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-indigo-600" />
                      AI Thinking Analysis
                    </h3>
                    <p className="text-sm text-indigo-700 mt-1">Discover your cognitive patterns and get personalized recommendations based on your chat history.</p>
                  </div>
                  <button 
                    onClick={handleAnalyzeProgress}
                    disabled={isAnalyzing || chats.length === 0}
                    className="shrink-0 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-5 py-2.5 rounded-xl font-medium transition-colors shadow-sm flex items-center gap-2"
                  >
                    {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    {isAnalyzing ? "Analyzing..." : "✨ Analyze My Progress"}
                  </button>
                </div>
                
                {analysisReport && (
                  <div className="bg-white/80 backdrop-blur-sm rounded-xl p-5 border border-indigo-50/50 text-slate-700 text-sm leading-relaxed space-y-4">
                    {analysisReport.split('\n').map((paragraph, i) => {
                      if (!paragraph.trim()) return null;
                      // Simple bold markdown parsing
                      const formattedText = paragraph.split(/(\*\*.*?\*\*)/).map((part, index) => 
                        part.startsWith('**') && part.endsWith('**') ? <strong key={index} className="text-indigo-900">{part.slice(2, -2)}</strong> : part
                      );
                      return <p key={i}>{formattedText}</p>;
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Chat Area */
          <>
            <div className="flex-1 overflow-y-auto p-4 md:p-6 scroll-smooth">
              <div className="max-w-3xl mx-auto space-y-6">
                {messages.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center mt-20">
                    <div className="w-20 h-20 bg-indigo-50 rounded-full flex items-center justify-center mb-6">
                      <Brain className="w-10 h-10 text-indigo-500" />
                    </div>
                    <h2 className="text-2xl font-bold text-slate-800 mb-2">Welcome to EducationalBot</h2>
                    <p className="text-slate-500 max-w-md mx-auto mb-8">
                      I'm here to help you explore ideas, uncover hidden biases, and strengthen your critical thinking skills. What's on your mind today?
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-lg">
                      <button onClick={() => setInput("Why do people believe the earth is flat?")} className="p-3 text-sm text-left bg-white border border-slate-200 hover:border-indigo-300 hover:shadow-md transition-all rounded-xl text-slate-600">"Why do people believe the earth is flat?"</button>
                      <button onClick={() => setInput("Are vaccines perfectly safe?")} className="p-3 text-sm text-left bg-white border border-slate-200 hover:border-indigo-300 hover:shadow-md transition-all rounded-xl text-slate-600">"Are vaccines perfectly safe?"</button>
                      <button onClick={() => setInput("What is the confirmation bias?")} className="p-3 text-sm text-left bg-white border border-slate-200 hover:border-indigo-300 hover:shadow-md transition-all rounded-xl text-slate-600">"What is the confirmation bias?"</button>
                      <button onClick={() => setInput("I read that 5G causes health issues.")} className="p-3 text-sm text-left bg-white border border-slate-200 hover:border-indigo-300 hover:shadow-md transition-all rounded-xl text-slate-600">"I read that 5G causes health issues."</button>
                    </div>
                  </div>
                ) : (
                  messages.map((msg, index) => (
                    <div key={index} className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      {msg.role === 'model' && (
                        <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center shrink-0 shadow-sm mt-1">
                          <Brain className="w-4 h-4 text-white" />
                        </div>
                      )}
                      
                      <div className={`
                        max-w-[85%] md:max-w-[75%] rounded-2xl px-5 py-4 shadow-sm
                        ${msg.role === 'user' 
                          ? 'bg-indigo-600 text-white rounded-br-none' 
                          : 'bg-white border border-slate-200 text-slate-800 rounded-bl-none'}
                      `}>
                        {msg.role === 'user' ? (
                          <div className="whitespace-pre-wrap">{msg.text}</div>
                        ) : (
                          renderFormattedText(msg.text)
                        )}
                      </div>

                      {msg.role === 'user' && (
                        <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center shrink-0 mt-1">
                          <UserCircle className="w-5 h-5 text-slate-500" />
                        </div>
                      )}
                    </div>
                  ))
                )}
                
                {isTyping && (
                  <div className="flex gap-4 justify-start">
                    <div className="w-8 h-8 rounded-full bg-indigo-600 flex items-center justify-center shrink-0 shadow-sm mt-1">
                      <Brain className="w-4 h-4 text-white" />
                    </div>
                    <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-none px-5 py-4 shadow-sm flex items-center gap-2">
                      <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
                      <span className="text-sm text-slate-500 font-medium">Analyzing perspective...</span>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Input Area */}
            <div className="bg-white border-t border-slate-200 p-4">
              <div className="max-w-3xl mx-auto relative">
                <form onSubmit={handleSendMessage} className="flex gap-2">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask a question or share a belief to explore..."
                    className="flex-1 bg-slate-100 text-slate-800 rounded-xl px-5 py-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-all shadow-inner"
                    disabled={isTyping}
                  />
                  <button
                    type="submit"
                    disabled={!input.trim() || isTyping}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl px-5 py-3.5 flex items-center justify-center transition-colors shadow-sm"
                  >
                    <Send className="w-5 h-5" />
                  </button>
                </form>
                <div className="text-center mt-2 text-xs text-slate-400">
                  EducationalBot helps explore ideas critically. It may occasionally make mistakes.
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
