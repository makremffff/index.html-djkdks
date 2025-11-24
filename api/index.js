// api/index.js

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * دالة موحدة لاستدعاء Supabase REST API
 * @param {string} table - اسم الجدول (مثل 'users', 'actions_log').
 * @param {string} method - طريقة HTTP (مثل 'POST', 'GET', 'PATCH').
 * @param {object} body - البيانات المراد إرسالها (في حالتي POST/PATCH).
 * @param {string} filter - سلاسل استعلام OData (مثل 'id=eq.1').
 * @returns {Promise<object>} - بيانات الاستجابة من Supabase.
 */
async function callSupabase(table, method, body = null, filter = "") {
    const url = `${SUPABASE_URL}/rest/v1/${table}${filter ? '?' + filter : ''}`;
    
    const headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
    
    // لإضافة 'Prefer: return=minimal' عند الإدراج لتسريع العملية
    if (method === 'POST' && table === 'actions_log') {
        headers['Prefer'] = 'return=minimal'; 
    }
    // لإضافة 'Prefer: return=representation' عند التحديث للحصول على البيانات المحدثة
    if (method === 'PATCH' || method === 'POST') {
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
            // Supabase API for a single row GET/PATCH returns an array, we take the first element
            const jsonResponse = await response.json();
            return Array.isArray(jsonResponse) && jsonResponse.length === 1 ? jsonResponse[0] : jsonResponse;
        } else {
            const errorText = await response.text();
            throw new Error(`Supabase Error: ${response.status} - ${errorText}`);
        }
    } catch (error) {
        console.error("Supabase Call Failed:", error);
        throw new Error(`Database operation failed: ${error.message}`);
    }
}


/**
 * دالة تسجيل الأكشن في جدول actions_log.
 * @param {number} userId - معرف المستخدم.
 * @param {string} action - نوع الأكشن.
 * @param {object} payload - بيانات الحمولة.
 */
async function logAction(userId, action, payload) {
    // لا ننتظر النتيجة هنا لتسريع الاستجابة للمستخدم
    callSupabase('actions_log', 'POST', {
        action: action,
        user_id: userId,
        payload: payload
    }).catch(err => {
        console.error(`Failed to log action ${action} for user ${userId}:`, err.message);
    });
}


module.exports = async (req, res) => {
    // 1. دعم CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }
    
    // 2. التحقق من أن الطلب هو POST
    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Method Not Allowed. Only POST is supported.' }));
        return;
    }

    try {
        // 3. قراءة وتحليل JSON Body
        const body = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => { data += chunk; });
            req.on('end', () => {
                try { resolve(JSON.parse(data)); } 
                catch (e) { reject(new Error('Invalid JSON format in request body.')); }
            });
            req.on('error', reject);
        });

        const { userId, action, ...data } = body;

        if (!userId || !action) {
            throw new Error('Missing required parameters: userId or action.');
        }

        // تسجيل الأكشن في الخلفية
        logAction(userId, action, body);

        let responseData = {};

        // 4. معالجة الأكشنات باستخدام switch(action)
        switch (action) {
            
            // ----------------------------------------------------
            // 1. الأكشن: getBalanceAndTaskStatus
            // ----------------------------------------------------
            case 'getBalanceAndTaskStatus':
                // 🚨 يجب أن تقوم بإنشاء جدول 'users' يحتوي على الأعمدة:
                // id (BIGINT/Unique), points (INT), usdt (NUMERIC), ticket (INT), join_status (TEXT), ads_left (INT)
                
                // جلب بيانات المستخدم
                const userData = await callSupabase('users', 'GET', null, `id=eq.${userId}&select=points,usdt,ticket,join_status,ads_left`);
                
                if (!userData) {
                     // 🚨 إذا لم يتم العثور على المستخدم، قم بإنشائه بالقيم الافتراضية
                     // const initialData = { id: userId, points: 0, usdt: 0.00, ticket: 0, join_status: 'join', ads_left: 300 };
                     // const newUser = await callSupabase('users', 'POST', initialData);
                     // throw new Error('User not found. Initializing...'); // أو إرجاع البيانات الافتراضية مباشرةً
                     throw new Error('User not found in DB. Please ensure user registration/upsert is handled.'); 
                }

                responseData = { 
                    points: userData.points, 
                    usdt: userData.usdt, 
                    ticket: userData.ticket, 
                    joinTaskStatus: userData.join_status || 'join', 
                    adsLeft: userData.ads_left || 300 
                };
                break;

            // ----------------------------------------------------
            // 2. الأكشن: addPoints
            // ----------------------------------------------------
            case 'addPoints':
                const points = data.points; 
                if (typeof points !== 'number' || points < 0) {
                     throw new Error('Invalid points value.');
                }
                
                // تحديث النقاط: يجب استخدام دالة PostgreSQL لتجنب السباق (Race Condition)
                // مثال: PATCH body: { points: points + points } (إذا كان SUPABASE يتيح ذلك)
                // أو استخدم دالة مخصصة لزيادة النقاط
                const updatedUserPoints = await callSupabase('users', 'PATCH', 
                    { points: points }, // يجب تعديل هذا ليكون تحديثاً آمناً (Safe Increment)
                    `id=eq.${userId}`
                );
                
                responseData = { message: `Successfully added ${points} points.` };
                break;

            // ----------------------------------------------------
            // 3. الأكشن: claimTaskReward
            // ----------------------------------------------------
            case 'claimTaskReward':
                const { task, reward } = data; 
                if (task !== 'joinChannel' || typeof reward !== 'number') {
                     throw new Error('Invalid task or reward data.');
                }
                
                // 🚨 التحقق من الانضمام يجب أن يتم هنا (خارج نطاق هذا الكود - عبر API Telegram)
                // إذا تم التحقق بنجاح:
                const updatedUserTask = await callSupabase('users', 'PATCH', 
                    { ticket: reward, join_status: 'claimed' }, // يجب تعديل هذا ليكون تحديثاً آمناً
                    `id=eq.${userId}&join_status=eq.check` // تأكد من أنه في حالة 'check'
                );
                
                if (!updatedUserTask) {
                    throw new Error('Claim failed. Task not ready or already claimed.');
                }

                responseData = { message: `Reward of ${reward} tickets claimed for ${task}.` };
                break;

            // ----------------------------------------------------
            // 4. الأكشن: watchAd
            // ----------------------------------------------------
            case 'watchAd':
                const adReward = data.reward; 
                if (typeof adReward !== 'number') {
                    throw new Error('Invalid ad reward value.');
                }
                
                // تحديث التذاكر وتقليل الإعلانات المتبقية
                const updatedUserAd = await callSupabase('users', 'PATCH', 
                    { ticket: adReward, ads_left: -1 }, // يجب تعديل هذا ليكون تحديثاً آمناً
                    `id=eq.${userId}&ads_left=gt.0` 
                );

                if (!updatedUserAd) {
                    throw new Error('Ad claim failed. No ads left to watch.');
                }

                responseData = { message: `Ad watched. ${adReward} ticket added.` };
                break;

            // ----------------------------------------------------
            // 5. الأكشن: executeSwap
            // ----------------------------------------------------
            case 'executeSwap':
                const { points: pointsToSwap, newPoints, newUsdt } = data;
                
                if (typeof pointsToSwap !== 'number' || typeof newPoints !== 'number' || !newUsdt) {
                     throw new Error('Invalid swap data.');
                }
                
                // 🚨 عملية المقايضة الحقيقية:
                // 1. جلب رصيد المستخدم الحالي للتحقق من كفاية النقاط.
                // 2. تحديث الرصيد بخصم النقاط وإضافة USDT.
                
                const updatedUserSwap = await callSupabase('users', 'PATCH', 
                    { points: newPoints, usdt: newUsdt }, 
                    `id=eq.${userId}` // يجب إضافة شرط للتحقق من الرصيد الكافي هنا أيضاً
                );
                
                responseData = { 
                    message: "Swap successful",
                    newPoints: newPoints, 
                    newUsdt: newUsdt 
                };
                break;
                
            // ----------------------------------------------------
            // 6. الأكشن: spin
            // ----------------------------------------------------
            case 'spin':
                // تنفيذ منطق Spin: خصم تذكرة/عملة، ثم إضافة المكافأة
                // const result = await callSupabase('users', 'PATCH', { /* خصم وإضافة */ }, `id=eq.${userId}`);
                responseData = { message: "Spin executed successfully, checking for reward..." };
                break;
                
            // ----------------------------------------------------
            // 7. الأكشن: ref
            // ----------------------------------------------------
            case 'ref':
                // جلب بيانات الإحالة:
                // const refData = await callSupabase('referrals', 'GET', null, `referrer_id=eq.${userId}`);
                responseData = { message: "Referral menu data prepared." };
                break;

            default:
                throw new Error(`Unknown action: ${action}`);
        }

        // 5. إرسال استجابة النجاح
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, action: action, ...responseData }));

    } catch (error) {
        // 6. إرسال استجابة الخطأ
        console.error(`Error processing request: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
    }
};