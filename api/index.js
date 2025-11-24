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
                const userData = await callSupabase('users', 'GET', null, `id=eq.${userId}&select=points,usdt,ticket,join_status,ads_left`);
                
                if (!userData) {
                     // 🚨 إذا لم يوجد المستخدم، يجب على الكود إنشاء مستخدم جديد هنا
                     throw new Error('User data not found. Please ensure user registration/upsert is implemented.'); 
                }

                responseData = { 
                    points: userData.points, 
                    usdt: userData.usdt, 
                    ticket: userData.ticket, 
                    joinTaskStatus: userData.join_status, 
                    adsLeft: userData.ads_left 
                };
                break;

            // ----------------------------------------------------
            // 2. الأكشن: addPoints
            // ----------------------------------------------------
            case 'addPoints':
                const points = data.points; 
                if (typeof points !== 'number' || points < 0) throw new Error('Invalid points value.');
                
                // 🚨 يجب استخدام RPC أو دالة تحديث آمنة لزيادة النقاط بشكل متزامن
                // await callSupabase('rpc/increment_points', 'POST', { user_id: userId, amount: points });
                responseData = { message: `Requested addition of ${points} points.` };
                break;

            // ----------------------------------------------------
            // 3. الأكشن: claimTaskReward
            // ----------------------------------------------------
            case 'claimTaskReward':
                const { task, reward } = data; 
                if (task !== 'joinChannel' || typeof reward !== 'number') throw new Error('Invalid task data.');
                
                // 🚨 تنفيذ التحقق من الانضمام ثم تحديث حالة المهمة وإضافة التذاكر
                // await callSupabase('users', 'PATCH', { /* تحديث */ }, `id=eq.${userId}&join_status=eq.check`);
                responseData = { message: `Requested claim for ${reward} tickets for ${task}.` };
                break;

            // ----------------------------------------------------
            // 4. الأكشن: watchAd
            // ----------------------------------------------------
            case 'watchAd':
                const adReward = data.reward; 
                if (typeof adReward !== 'number') throw new Error('Invalid ad reward.');
                
                // 🚨 تنفيذ خصم إعلان واحد وزيادة التذكرة بشكل آمن
                // await callSupabase('users', 'PATCH', { /* تحديث */ }, `id=eq.${userId}&ads_left=gt.0`);
                responseData = { message: `Requested ad watch and ${adReward} ticket addition.` };
                break;

            // ----------------------------------------------------
            // 5. الأكشن: executeSwap
            // ----------------------------------------------------
            case 'executeSwap':
                const { newPoints, newUsdt } = data;
                
                if (typeof newPoints !== 'number' || !newUsdt) throw new Error('Invalid swap data.');
                
                // 🚨 تنفيذ عملية المقايضة (خصم النقاط وإضافة USDT) كـ Transaction
                // await callSupabase('rpc/execute_swap_transaction', 'POST', { user_id: userId, new_points: newPoints, new_usdt: newUsdt });
                
                responseData = { 
                    message: "Swap request sent for processing.",
                    newPoints: newPoints, 
                    newUsdt: newUsdt 
                };
                break;
                
            // ----------------------------------------------------
            // 6. الأكشن: spin
            // ----------------------------------------------------
            case 'spin':
                // 🚨 تنفيذ منطق Spin (خصم تذكرة/عملة، ثم إضافة المكافأة)
                // await callSupabase('rpc/execute_spin', 'POST', { user_id: userId });
                responseData = { message: "Spin request sent." };
                break;
                
            // ----------------------------------------------------
            // 7. الأكشن: ref
            // ----------------------------------------------------
            case 'ref':
                // 🚨 جلب بيانات الإحالة
                // const refData = await callSupabase('referrals', 'GET', null, `referrer_id=eq.${userId}`);
                responseData = { message: "Referral data requested." };
                break;

            default:
                throw new Error(`Unknown action: ${action}`);
        }

        // إرسال استجابة النجاح
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action: action, ...responseData }));

    } catch (error) {
        // إرسال استجابة الخطأ
        console.error(`Error processing request: ${error.message}`);
        const statusCode = error.message.includes('JSON') || error.message.includes('Missing') ? 400 : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
    }
};