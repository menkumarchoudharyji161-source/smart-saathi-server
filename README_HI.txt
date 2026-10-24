SMART SAATHI SERVER — नई सर्वर फ़ाइलें

इस पैकेज में server.js, package.json, render.yaml, smoke-test.js और README_HI.txt हैं।

API:
GET  /api/health — सर्वर और API key की मौजूदगी
POST /api/chat   — AI चैट; JSON में message या prompt भेजें
POST /api/vision — फोटो का विश्लेषण; JSON में image (HTTPS URL या data URL) और message/question भेजें
POST /api/search — वेब सर्च; JSON में query भेजें

Render:
Build Command: npm install
Start Command: npm start
Environment में OPENAI_API_KEY सेट करें और OPENAI_MODEL=gpt-4.1-mini रखें। असली API key कभी GitHub की फ़ाइल में न लिखें।

जाँच:
Deploy के बाद https://YOUR-SERVICE.onrender.com/api/health खोलें।
स्थानीय जाँच के लिए npm test चलाएँ।

ध्यान दें:
- यह पैकेज खुद GitHub पर अपलोड या Render पर deploy नहीं करता।
- बदलने से पहले मौजूदा फाइलों की backup रखें।
- API इस्तेमाल करने पर OpenAI खाते में शुल्क लग सकता है।
- सर्वर में AI चैट, फोटो विश्लेषण और web search endpoints हैं। Notes, reminders, PIN lock और पशु/दूध हिसाब जैसे ऐप फीचर HTML ऐप में होते हैं; यह सर्वर उन्हें अपने-आप नहीं जोड़ता।
- किसी भी software change में बिना live deploy और test के zero-problem की गारंटी नहीं दी जा सकती।
