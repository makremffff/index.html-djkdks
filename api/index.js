// api/index.js

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// -------------------------------------------------------------------
// 1. دالة مساعدة لقراءة الـ Body يدوياً (بدون Express)
// -------------------------------------------------------------------
async function getBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            try {
                if (!data) return resolve({});
                resolve(JSON.parse(data));
            } catch (e) {
                reject(new Error('Invalid JSON format in request body.'));
            }
        });
        req.on('error', reject);
    });
}

// -------------------------------------------------------------------
// 2. دالة موحدة لاستدعاء Supabase (REST API فقط)
// -------------------------------------------------------------------
/**
 * @param {string} table - اسم الجدول (مثل 'users', 'actions_log').
 * @param {string} method - طريقة HTTP (مثل 'POST', 'GET', 'PATCH').
 * @param {object} body - البيانات المراد إرسالها.
 * @param {string} filter - سلاسل استعلام OData.
 */
async function callSupabase(table, method, body = null, filter = "") {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error('Supabase credentials are not configured.');
    }
    
    const url = `${SUPABASE_URL}/rest/v1/${table}${filter ? '?' + filter : ''}`;
    
    const headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
    
    // إعداد Prefer header للتعامل مع الإدراج والتحديث
    if (method === 'POST' && table === 'actions_log') {
        headers['Prefer'] = 'return=minimal'; 
    } else if (method === 'PATCH' || method === 'POST') {
        headers['Prefer'] = 'return=representation'; 
    }

    try {
        const fetchOptions = {
            method: method,
            headers: headers,
            body: body ? JSON.stringify(body) : null
        };

        const response = await fetch(url, fetchOptions);

        if (response.ok) {
            if (response.status === 204) return { success: true, data: null };
            
            const jsonResponse = await response.json();
            // Supabase returns an array for single-row queries/updates, we normalize it.
            if (Array.isArray(jsonResponse) && jsonResponse.length === 1) {
                return jsonResponse[0];
            }
            return jsonResponse;

        } else {
            const errorText = await response.text();
            throw new Error(`Supabase API Error ${response.status}: ${errorText}`);
        }
    } catch (error) {
        console.error("Supabase Call Failed:", error);
        throw new Error(`Database operation failed: ${error.message}`);
    }
}

// -------------------------------------------------------------------
// 3. دالة تسجيل الأكشن في جدول actions_log
// -------------------------------------------------------------------
async function logAction(userId, action, payload) {
    // Fire and forget: لا ننتظر النتيجة لتسريع الاستجابة للمستخدم
    callSupabase('actions_log', 'POST', {
        action: action,
        user_id: userId,
        payload: payload
    }).catch(err => {
        // نكتفي بالتسجيل في console Vercel
        console.error(`Failed to log action ${action}:`, err.message);
    });
}


// -------------------------------------------------------------------
// 4. دالة Backend الرئيسية لـ Vercel Serverless
// -------------------------------------------------------------------
module.exports = async (req, res) => {
    
    // دعم CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // معالجة طلب OPTIONS (Pre-flight request)
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // التحقق من أن الطلب POST فقط
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed. Only POST is supported.' }));
        return;
    }

    try {
        const body = await getBody(req);
        const { userId, action, ...data } = body;

        if (!userId || !action) {
            throw new Error('Missing required parameters: userId or action.');
        }

        // تسجيل الأكشن
        logAction(userId, action, body);

        let responseData = {};

        // معالجة الأكشنات الـ 7 المستخلصة من index.html
        switch (action) {
            
            // ----------------------------------------------------
            // 1. الأكشن: getBalanceAndTaskStatus
            // ----------------------------------------------------
            case 'getBalanceAndTaskStatus':
                // جلب بيانات المستخدم: نقاط, USDT, تذاكر, حالة المهمة, الإعلانات المتبقية
                // 🚨 تم تعديل الاستعلام ليشمل games_played
                const userData = await callSupabase('users', 'GET', null, `id=eq.${userId}&select=points,usdt,ticket,join_status,ads_left,games_played`);
                
                if (!userData) {
                     // 🚨 إذا لم يوجد المستخدم، يجب على الكود إنشاء مستخدم جديد هنا
                     throw new Error('User data not found. Please ensure user registration/upsert is implemented.'); 
                }

                responseData = { 
                    points: userData.points, 
                    usdt: userData.usdt, 
                    ticket: userData.ticket, 
                    joinTaskStatus: userData.join_status, 
                    adsLeft: userData.ads_left,
                    gamesPlayed: userData.games_played // 🚨 تم إضافة هذا الحقل
                };
                break;

            // ----------------------------------------------------
            // 2. الأكشن: recordGameEnd (الجديد: يضيف النقاط ويزيد عداد الألعاب)
            // ----------------------------------------------------
            case 'recordGameEnd':
                const points = data.points; 
                if (typeof points