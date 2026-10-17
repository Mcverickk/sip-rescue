// Everything the scripted agent says, in three hand-written forms:
//   en       canonical English (source for machine translation into other Indian languages)
//   hinglish what Hinglish users see as captions (Latin script)
//   hi       Devanagari; also what Sarvam TTS speaks for Hinglish, because it pronounces native script best
// Other languages are translated from `en` by Sarvam (mayura:v1, modern-colloquial) and cached.
//
// Conversion choices: praise the habit first, say "no penalty" early, frame the ask as protecting a
// streak, make each offer one small easy step, and never offer cancellation.

export const LANGS = [
  { id: "hinglish", label: "Hinglish", english: "Hinglish", code: "hi-IN", sttMode: "translit" },
  { id: "hi", label: "हिन्दी", english: "Hindi", code: "hi-IN", sttMode: "transcribe" },
  { id: "en", label: "English", english: "English", code: "en-IN", sttMode: "transcribe" },
  { id: "bn", label: "বাংলা", english: "Bengali", code: "bn-IN", sttMode: "transcribe" },
  { id: "mr", label: "मराठी", english: "Marathi", code: "mr-IN", sttMode: "transcribe" },
  { id: "ta", label: "தமிழ்", english: "Tamil", code: "ta-IN", sttMode: "transcribe" },
  { id: "te", label: "తెలుగు", english: "Telugu", code: "te-IN", sttMode: "transcribe" },
  { id: "gu", label: "ગુજરાતી", english: "Gujarati", code: "gu-IN", sttMode: "transcribe" },
  { id: "kn", label: "ಕನ್ನಡ", english: "Kannada", code: "kn-IN", sttMode: "transcribe" },
  { id: "ml", label: "മലയാളം", english: "Malayalam", code: "ml-IN", sttMode: "transcribe" },
  { id: "pa", label: "ਪੰਜਾਬੀ", english: "Punjabi", code: "pa-IN", sttMode: "transcribe" },
  { id: "od", label: "ଓଡ଼ିଆ", english: "Odia", code: "od-IN", sttMode: "transcribe" },
];
export const langById = (id) => LANGS.find((l) => l.id === id) ?? LANGS[0];

export const LINES = {
  hello: {
    en: "Hello Murari ji! This is Sia from Bachatt. I have a quick update about your Smart Deposit savings, it will take just a minute. Is now a good time to talk?",
    hinglish: "Namaste Murari ji! Main Sia, Bachatt se bol rahi hoon. Aapki Smart Deposit savings ke baare mein ek chhoti si baat thi, bas ek minute lagega. Kya abhi baat kar sakte hain?",
    hi: "नमस्ते मुरारी जी! मैं सिया, बचत से बोल रही हूँ। आपकी स्मार्ट डिपॉज़िट सेविंग्स के बारे में एक छोटी सी बात थी, बस एक मिनट लगेगा। क्या अभी बात कर सकते हैं?",
  },
  explain: {
    en: "Thank you! You are saving 100 rupees every day, that is wonderful. For the last two days the balance in your Bank of Baroda account was low, so the instalment could not go through. Don't worry, there is no penalty at all. Tomorrow morning 100 rupees will be debited again. Could you add 500 rupees to the account tonight, so your savings streak does not break?",
    hinglish: "Shukriya! Aap roz 100 rupaye bacha rahe hain, bahut badhiya. Bas pichhle do din aapke Bank of Baroda account mein balance kam tha, isliye kist kat nahi paayi. Ghabraiye mat, iski koi penalty nahi hai. Kal subah phir 100 rupaye katenge. Kya aap aaj raat account mein 500 rupaye daal sakte hain, taaki aapki bachat ka silsila na toote?",
    hi: "शुक्रिया! आप रोज़ 100 रुपये बचा रहे हैं, बहुत बढ़िया। बस पिछले दो दिन आपके बैंक ऑफ़ बड़ौदा अकाउंट में बैलेंस कम था, इसलिए किस्त कट नहीं पाई। घबराइए मत, इसकी कोई पेनल्टी नहीं है। कल सुबह फिर 100 रुपये कटेंगे। क्या आप आज रात अकाउंट में 500 रुपये डाल सकते हैं, ताकि आपकी बचत का सिलसिला न टूटे?",
  },
  topup_yes: {
    en: "Wonderful! I have sent you a link by SMS, you can add the money in two minutes. Tomorrow morning your instalment will go through on its own. Thank you Murari ji, keep saving like this!",
    hinglish: "Bahut badhiya! Maine aapko SMS par ek link bhej diya hai, usse do minute mein paise daal sakte hain. Kal subah aapki kist apne aap kat jaayegi. Dhanyavaad Murari ji, aise hi bachat karte rahiye!",
    hi: "बहुत बढ़िया! मैंने आपको SMS पर एक लिंक भेज दिया है, उससे दो मिनट में पैसे डाल सकते हैं। कल सुबह आपकी किस्त अपने आप कट जाएगी। धन्यवाद मुरारी जी, ऐसे ही बचत करते रहिए!",
  },
  offer_reduce: {
    en: "No problem, it happens. Here is an easy option: save just 50 rupees a day instead of 100. Your savings keep going and the instalment will not get stuck. Shall I make it 50 rupees?",
    hinglish: "Koi baat nahi, aisa hota hai. Ek aasaan raasta hai: roz 100 ki jagah sirf 50 rupaye bachaiye. Bachat chalti rahegi aur kist bhi nahi atkegi. 50 rupaye kar dein?",
    hi: "कोई बात नहीं, ऐसा होता है। एक आसान रास्ता है: रोज़ 100 की जगह सिर्फ़ 50 रुपये बचाइए। बचत चलती रहेगी और किस्त भी नहीं अटकेगी। 50 रुपये कर दें?",
  },
  reduce_yes: {
    en: "Done! From tomorrow your daily saving is 50 rupees. You can increase it again in the app any time. A confirmation SMS is on its way. Thank you Murari ji!",
    hinglish: "Ho gaya! Kal se aapki roz ki bachat 50 rupaye hai. Jab chahein app mein wapas badha sakte hain. SMS par confirmation aa raha hai. Shukriya Murari ji!",
    hi: "हो गया! कल से आपकी रोज़ की बचत 50 रुपये है। जब चाहें ऐप में वापस बढ़ा सकते हैं। SMS पर कन्फ़र्मेशन आ रहा है। शुक्रिया मुरारी जी!",
  },
  offer_bank: {
    en: "I understand. Do you have another bank account where you usually keep money? I can send a link so your savings are debited from that account instead.",
    hinglish: "Samajh gayi. Kya aapka koi aur bank account hai jismein paise rehte hain? Main ek link bhej sakti hoon, jisse aapki bachat wahan se kategi.",
    hi: "समझ गई। क्या आपका कोई और बैंक अकाउंट है जिसमें पैसे रहते हैं? मैं एक लिंक भेज सकती हूँ, जिससे आपकी बचत वहाँ से कटेगी।",
  },
  bank_yes: {
    en: "I have sent the link. Open it and approve AutoPay on the new account, it takes just a minute. Until then everything continues as before. Thank you Murari ji!",
    hinglish: "Maine link bhej diya hai. Use kholkar naye account par AutoPay approve kar dijiye, bas ek minute ka kaam hai. Tab tak sab pehle jaisa chalega. Shukriya Murari ji!",
    hi: "मैंने लिंक भेज दिया है। उसे खोलकर नए अकाउंट पर ऑटोपे अप्रूव कर दीजिए, बस एक मिनट का काम है। तब तक सब पहले जैसा चलेगा। शुक्रिया मुरारी जी!",
  },
  offer_pause: {
    en: "Okay. Then shall we pause your savings for 15 days? Your money stays safe, and it restarts on its own on 29 October. You can also choose 7 or 30 days.",
    hinglish: "Theek hai. Toh kya hum aapki bachat 15 din ke liye rok dein? Aapke jama paise surakshit rahenge aur 29 October se apne aap phir shuru ho jaayegi. Chahein toh 7 ya 30 din bhi kar sakte hain.",
    hi: "ठीक है। तो क्या हम आपकी बचत 15 दिन के लिए रोक दें? आपके जमा पैसे सुरक्षित रहेंगे और 29 अक्टूबर से अपने आप फिर शुरू हो जाएगी। चाहें तो 7 या 30 दिन भी कर सकते हैं।",
  },
  pause_7: {
    en: "Done, your savings are paused for 7 days and will restart on their own on 21 October. A confirmation SMS is on its way. Thank you Murari ji!",
    hinglish: "Ho gaya, aapki bachat 7 din ke liye ruki hai aur 21 October se apne aap shuru ho jaayegi. SMS par confirmation aa raha hai. Shukriya Murari ji!",
    hi: "हो गया, आपकी बचत 7 दिन के लिए रुकी है और 21 अक्टूबर से अपने आप शुरू हो जाएगी। SMS पर कन्फ़र्मेशन आ रहा है। शुक्रिया मुरारी जी!",
  },
  pause_15: {
    en: "Done, your savings are paused for 15 days and will restart on their own on 29 October. A confirmation SMS is on its way. Thank you Murari ji!",
    hinglish: "Ho gaya, aapki bachat 15 din ke liye ruki hai aur 29 October se apne aap shuru ho jaayegi. SMS par confirmation aa raha hai. Shukriya Murari ji!",
    hi: "हो गया, आपकी बचत 15 दिन के लिए रुकी है और 29 अक्टूबर से अपने आप शुरू हो जाएगी। SMS पर कन्फ़र्मेशन आ रहा है। शुक्रिया मुरारी जी!",
  },
  pause_30: {
    en: "Done, your savings are paused for 30 days and will restart on their own on 13 November. A confirmation SMS is on its way. Thank you Murari ji!",
    hinglish: "Ho gaya, aapki bachat 30 din ke liye ruki hai aur 13 November se apne aap shuru ho jaayegi. SMS par confirmation aa raha hai. Shukriya Murari ji!",
    hi: "हो गया, आपकी बचत 30 दिन के लिए रुकी है और 13 नवंबर से अपने आप शुरू हो जाएगी। SMS पर कन्फ़र्मेशन आ रहा है। शुक्रिया मुरारी जी!",
  },
  cancel_pushback: {
    en: "I understand. But stopping completely would break your daily saving habit. Shall we just pause it for 15 days instead? Your money stays invested and it restarts without any hassle.",
    hinglish: "Main samajhti hoon. Par band karne se aapki roz ki bachat ki aadat toot jaayegi. Kya hum ise bas 15 din ke liye rok dein? Aapke paise jama rahenge aur baad mein bina jhanjhat shuru ho jaayega.",
    hi: "मैं समझती हूँ। पर बंद करने से आपकी रोज़ की बचत की आदत टूट जाएगी। क्या हम इसे बस 15 दिन के लिए रोक दें? आपके पैसे जमा रहेंगे और बाद में बिना झंझट शुरू हो जाएगा।",
  },
  cancel_yes: {
    en: "Okay, your SIP has been stopped. Your 140 rupees stay safe and you can withdraw them any time. Whenever you like, you can restart from the app. Thank you Murari ji.",
    hinglish: "Theek hai, aapki SIP band kar di gayi hai. Aapke jama 140 rupaye surakshit hain, kabhi bhi nikaal sakte hain. Jab mann ho, app se phir shuru kar lijiye. Shukriya Murari ji.",
    hi: "ठीक है, आपकी SIP बंद कर दी गई है। आपके जमा 140 रुपये सुरक्षित हैं, कभी भी निकाल सकते हैं। जब मन हो, ऐप से फिर शुरू कर लीजिए। शुक्रिया मुरारी जी।",
  },
  no_change: {
    en: "No problem, your savings will continue just as they are. You can change anything in the app at any time. Thank you Murari ji!",
    hinglish: "Koi baat nahi, aapki bachat jaise chal rahi hai waise chalti rahegi. Koi bhi badlaav app mein kabhi bhi kar sakte hain. Shukriya Murari ji!",
    hi: "कोई बात नहीं, आपकी बचत जैसे चल रही है वैसे चलती रहेगी। कोई भी बदलाव ऐप में कभी भी कर सकते हैं। शुक्रिया मुरारी जी!",
  },
  busy: {
    en: "Of course, I will call you again tomorrow evening at 7. Thank you Murari ji!",
    hinglish: "Bilkul, main kal shaam 7 baje phir call karungi. Shukriya Murari ji!",
    hi: "बिल्कुल, मैं कल शाम 7 बजे फिर कॉल करूँगी। शुक्रिया मुरारी जी!",
  },
  wrong_person: {
    en: "Sorry, I seem to have the wrong number. Have a good day.",
    hinglish: "Maaf kijiye, galat number lag gaya. Aapka din shubh ho.",
    hi: "माफ़ कीजिए, ग़लत नंबर लग गया। आपका दिन शुभ हो।",
  },
  unclear: {
    en: "Sorry, I could not hear that properly. Could you say it once more?",
    hinglish: "Maaf kijiye, main theek se sun nahi paayi. Kya aap ek baar phir bol sakte hain?",
    hi: "माफ़ कीजिए, मैं ठीक से सुन नहीं पाई। क्या आप एक बार फिर बोल सकते हैं?",
  },
};

// Suggested replies per ladder stage. `en` is what the intent matcher reads.
export const CHIPS = {
  start: [
    { en: "Yes, go ahead", hinglish: "Haan, boliye", hi: "हाँ, बोलिए" },
    { en: "I am busy, call me later", hinglish: "Abhi busy hoon, baad mein call karo", hi: "अभी बिज़ी हूँ, बाद में कॉल करो" },
  ],
  topup: [
    { en: "Yes, I will add 500 tonight", hinglish: "Haan, aaj raat 500 daal dunga", hi: "हाँ, आज रात 500 डाल दूँगा" },
    { en: "I don't have money right now, my salary comes on the 1st", hinglish: "Abhi paise nahi hain, salary 1 tareekh ko aayegi", hi: "अभी पैसे नहीं हैं, सैलरी 1 तारीख को आएगी" },
  ],
  reduce: [
    { en: "Yes, make it 50", hinglish: "Haan, 50 rupaye kar do", hi: "हाँ, 50 रुपये कर दो" },
    { en: "No, don't lower the amount", hinglish: "Nahi, amount kam nahi karna", hi: "नहीं, अमाउंट कम नहीं करना" },
  ],
  bank: [
    { en: "Yes, I have an SBI account", hinglish: "Haan, mera SBI account hai", hi: "हाँ, मेरा SBI अकाउंट है" },
    { en: "No, I don't have another account", hinglish: "Nahi, doosra account nahi hai", hi: "नहीं, दूसरा अकाउंट नहीं है" },
  ],
  pause: [
    { en: "Yes, pause it for 15 days", hinglish: "Haan, 15 din ke liye rok do", hi: "हाँ, 15 दिन के लिए रोक दो" },
    { en: "No, I want to cancel the SIP", hinglish: "Nahi, mujhe SIP band karni hai", hi: "नहीं, मुझे SIP बंद करनी है" },
  ],
};

// Confirmation SMS bodies. Links are fixed so the text can be translated and cached ahead of time.
export const SMS = {
  topup: {
    en: "Murari ji, add 500 rupees to your Bank of Baroda account XX9428 tonight so tomorrow's 100 rupee saving goes through: bachatt.app/t/mr500 - Bachatt",
    hinglish: "Murari ji, aaj raat Bank of Baroda a/c XX9428 mein 500 rupaye daalein taaki kal ki 100 rupaye ki bachat kat sake: bachatt.app/t/mr500 - Bachatt",
    hi: "मुरारी जी, आज रात बैंक ऑफ़ बड़ौदा a/c XX9428 में 500 रुपये डालें ताकि कल की 100 रुपये की बचत कट सके: bachatt.app/t/mr500 - Bachatt",
  },
  reduce: {
    en: "Murari ji, your Smart Deposit saving is now 50 rupees a day from 14 Oct. Change it any time in the app. - Bachatt",
    hinglish: "Murari ji, aapki Smart Deposit bachat ab 14 Oct se roz 50 rupaye hai. App mein kabhi bhi badal sakte hain. - Bachatt",
    hi: "मुरारी जी, आपकी स्मार्ट डिपॉज़िट बचत अब 14 अक्टूबर से रोज़ 50 रुपये है। ऐप में कभी भी बदल सकते हैं। - Bachatt",
  },
  bank: {
    en: "Murari ji, open this link and approve UPI AutoPay to move your savings to your new bank account: bachatt.app/m/mrbank - Bachatt",
    hinglish: "Murari ji, naye bank account se bachat jodne ke liye yeh link kholein aur UPI AutoPay approve karein: bachatt.app/m/mrbank - Bachatt",
    hi: "मुरारी जी, नए बैंक अकाउंट से बचत जोड़ने के लिए यह लिंक खोलें और UPI ऑटोपे अप्रूव करें: bachatt.app/m/mrbank - Bachatt",
  },
  pause_7: {
    en: "Murari ji, your Smart Deposit saving is paused for 7 days and restarts on 21 Oct. - Bachatt",
    hinglish: "Murari ji, aapki Smart Deposit bachat 7 din ke liye ruki hai, 21 Oct se phir shuru hogi. - Bachatt",
    hi: "मुरारी जी, आपकी स्मार्ट डिपॉज़िट बचत 7 दिन के लिए रुकी है, 21 अक्टूबर से फिर शुरू होगी। - Bachatt",
  },
  pause_15: {
    en: "Murari ji, your Smart Deposit saving is paused for 15 days and restarts on 29 Oct. - Bachatt",
    hinglish: "Murari ji, aapki Smart Deposit bachat 15 din ke liye ruki hai, 29 Oct se phir shuru hogi. - Bachatt",
    hi: "मुरारी जी, आपकी स्मार्ट डिपॉज़िट बचत 15 दिन के लिए रुकी है, 29 अक्टूबर से फिर शुरू होगी। - Bachatt",
  },
  pause_30: {
    en: "Murari ji, your Smart Deposit saving is paused for 30 days and restarts on 13 Nov. - Bachatt",
    hinglish: "Murari ji, aapki Smart Deposit bachat 30 din ke liye ruki hai, 13 Nov se phir shuru hogi. - Bachatt",
    hi: "मुरारी जी, आपकी स्मार्ट डिपॉज़िट बचत 30 दिन के लिए रुकी है, 13 नवंबर से फिर शुरू होगी। - Bachatt",
  },
  cancel: {
    en: "Murari ji, your Smart Deposit SIP is stopped. Your 140 rupees stay invested and can be withdrawn any time. - Bachatt",
    hinglish: "Murari ji, aapki Smart Deposit SIP band hai. Aapke 140 rupaye invested hain, kabhi bhi nikaal sakte hain. - Bachatt",
    hi: "मुरारी जी, आपकी स्मार्ट डिपॉज़िट SIP बंद है। आपके 140 रुपये निवेशित हैं, कभी भी निकाल सकते हैं। - Bachatt",
  },
};
