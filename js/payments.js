console.log('💰 Payments module loading...');

const WORKER_URL = 'https://checklistings.dan-svistunov.workers.dev';
const CHECKLIST_PRICE = 100;

let tg = null;
let userId = null;
let invoiceCache = null; // Кешируем последний инвойс

async function waitForTelegram() {
  for (let i = 0; i < 50; i++) {
    if (window.Telegram && window.Telegram.WebApp) {
      tg = window.Telegram.WebApp;
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (!tg) {
    console.log('❌ Telegram not found');
    return false;
  }

  try {
    tg.ready();
    tg.expand();
    userId = tg.initDataUnsafe?.user?.id;
    console.log('✅ Telegram ready, userId:', userId);
    return true;
  } catch (e) {
    console.error('Error:', e);
    return false;
  }
}

const readyPromise = waitForTelegram();

function getPaid() {
  try { return JSON.parse(localStorage.getItem('paidChecklists') || '{}'); }
  catch { return {}; }
}

function setPaid(id) {
  const paid = getPaid();
  paid[id] = true;
  localStorage.setItem('paidChecklists', JSON.stringify(paid));
}

export function isPaid(id) {
  return getPaid()[id] === true;
}

export function needsPayment(checklist, category) {
  if (!checklist) return false;
  if (isPaid(checklist.id)) return false;
  if (category && category.free_checklist === checklist.id) return false;
  return true;
}

// Предсоздание инвойса в фоне
async function preCreateInvoice(title, checklistId) {
  try {
    console.log('🔄 Предсоздание инвойса...');
    const payload = JSON.stringify({
      checklist_id: checklistId,
      user_id: userId,
      timestamp: Date.now(),
      random: Math.random().toString(36).substring(7)
    });

    const response = await fetch(`${WORKER_URL}/api/create-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        title: title.substring(0, 32),
        description: `Доступ к чек-листу "${title}"`.substring(0, 255),
        payload: payload,
        prices: [{ label: 'Чек-лист', amount: CHECKLIST_PRICE }]
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.details || 'Ошибка сервера');
    }

    const data = await response.json();
    if (!data.invoice_url) throw new Error('Нет ссылки на оплату');
    
    invoiceCache = {
      url: data.invoice_url,
      checklistId,
      timestamp: Date.now()
    };
    
    console.log('✅ Инвойс предсоздан');
    return data.invoice_url;
  } catch (e) {
    console.error('Ошибка предсоздания:', e);
    invoiceCache = null;
    return null;
  }
}

// Быстрое создание инвойса
async function createInvoiceQuick(title, checklistId) {
  // Если есть свежий кеш (младше 5 секунд) - используем его
  if (invoiceCache && 
      invoiceCache.checklistId === checklistId && 
      (Date.now() - invoiceCache.timestamp) < 5000) {
    console.log('⚡ Используем кешированный инвойс');
    const url = invoiceCache.url;
    invoiceCache = null;
    return url;
  }

  const payload = JSON.stringify({
    checklist_id: checklistId,
    user_id: userId,
    timestamp: Date.now(),
    random: Math.random().toString(36).substring(7)
  });

  const response = await fetch(`${WORKER_URL}/api/create-invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      title: title.substring(0, 32),
      description: `Доступ к чек-листу "${title}"`.substring(0, 255),
      payload: payload,
      prices: [{ label: 'Чек-лист', amount: CHECKLIST_PRICE }]
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.details || 'Ошибка сервера');
  }

  const data = await response.json();
  if (!data.invoice_url) throw new Error('Нет ссылки на оплату');
  
  return data.invoice_url;
}

function openInvoice(url) {
  return new Promise((resolve) => {
    let resolved = false;

    const handleClose = () => {
      if (resolved) return;
      resolved = true;
      tg.offEvent('invoiceClosed', handleClose);
      console.log('✅ Invoice closed');
      resolve({ success: true });
    };

    tg.onEvent('invoiceClosed', handleClose);

    try {
      tg.openInvoice(url, (status) => {
        console.log('Callback status:', status);
        
        if (status === 'paid') {
          if (!resolved) {
            resolved = true;
            tg.offEvent('invoiceClosed', handleClose);
            resolve({ success: true });
          }
        } else if (status === 'failed') {
          if (!resolved) {
            resolved = true;
            tg.offEvent('invoiceClosed', handleClose);
            resolve({ success: false, error: 'failed' });
          }
        } else if (status === 'cancelled') {
          if (!resolved) {
            resolved = true;
            tg.offEvent('invoiceClosed', handleClose);
            resolve({ success: false, error: 'cancelled' });
          }
        }
      });
    } catch (e) {
      if (!resolved) {
        resolved = true;
        tg.offEvent('invoiceClosed', handleClose);
        resolve({ success: false, error: 'exception' });
      }
    }

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        tg.offEvent('invoiceClosed', handleClose);
        resolve({ success: false, error: 'timeout' });
      }
    }, 120000);
  });
}

export async function payForChecklist(checklistId, title) {
  const ready = await readyPromise;

  if (!ready || !tg) {
    alert('Оплата доступна только в Telegram\nОткройте приложение через бота');
    return false;
  }

  if (!userId) {
    alert('Не удалось идентифицировать пользователя');
    return false;
  }

  const existingModals = document.querySelectorAll('.modal');
  existingModals.forEach(m => m.remove());

  const loadingModal = document.createElement('div');
  loadingModal.className = 'modal';
  loadingModal.id = 'loading-modal';
  loadingModal.innerHTML = `<div class="modal-content"><div style="font-size:18px;">⏳</div><p>Создаём счёт...</p></div>`;
  document.body.appendChild(loadingModal);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Используем быстрое создание с кешем
      const url = await createInvoiceQuick(title, checklistId);
      
      const lm = document.getElementById('loading-modal');
      if (lm) lm.remove();
      
      // Минимальная пауза
      await new Promise(r => setTimeout(r, 100));
      
      console.log(`Opening invoice, attempt ${attempt}/3`);
      const result = await openInvoice(url);
      console.log(`Attempt ${attempt} result:`, result);
      
      if (result.success) {
        setPaid(checklistId);
        return true;
      }
      
      if (result.error === 'cancelled') {
        return false;
      }
      
      if (result.error === 'failed' && attempt < 3) {
        console.log(`Load failed, попытка ${attempt}/3`);
        
        const retryModal = document.createElement('div');
        retryModal.className = 'modal';
        retryModal.id = 'loading-modal';
        retryModal.innerHTML = `<div class="modal-content"><div style="font-size:18px;">⏳</div><p>Создаём новый счёт...</p></div>`;
        document.body.appendChild(retryModal);
        
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      
      if (attempt === 3 && result.error === 'failed') {
        const lm2 = document.getElementById('loading-modal');
        if (lm2) lm2.remove();
        alert('Не удалось открыть оплату.\n\nПопробуйте еще раз.');
      }
      
      return false;
      
    } catch (e) {
      console.error(`Attempt ${attempt} error:`, e);
      if (attempt === 3) {
        const lm3 = document.getElementById('loading-modal');
        if (lm3) lm3.remove();
        alert('Ошибка: ' + e.message);
        return false;
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  const lm4 = document.getElementById('loading-modal');
  if (lm4) lm4.remove();
  return false;
}

// Предсоздаем инвойс при открытии модалки
export function showPaymentModal(checklistId, title, subtitle, onSuccess) {
  const existing = document.querySelector('.modal');
  if (existing) existing.remove();

  // Начинаем предсоздание инвойса в фоне
  preCreateInvoice(title, checklistId);

  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:340px;width:90%;padding:24px 20px;text-align:center;">
      <h3 style="font-size:20px;font-weight:700;margin:0 0 8px 0;color:#1c1c1e;">
        Доступ к чек-листу
      </h3>
      
      <p style="font-size:15px;font-weight:600;margin:0 0 4px 0;color:#333;line-height:1.3;">
        ${title}
      </p>
      
      ${subtitle ? `
        <p style="font-size:13px;color:#8e8e93;margin:0 0 16px 0;line-height:1.4;">
          ${subtitle}
        </p>
      ` : '<div style="margin-bottom:16px;"></div>'}
      
      <div style="background:#f2f2f7;border-radius:14px;padding:14px;margin-bottom:12px;display:flex;align-items:center;justify-content:center;gap:8px;">
        <span style="font-size:32px;font-weight:800;color:#ff9500;line-height:1;">${CHECKLIST_PRICE}</span>
        <span style="font-size:24px;line-height:1;">⭐</span>
      </div>
      
      <div style="display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:20px;padding:10px 14px;background:rgba(52,199,89,0.08);border-radius:10px;">
        <span style="font-size:15px;">✅</span>
        <span style="font-size:13px;font-weight:600;color:#34c759;">Доступ навсегда</span>
      </div>
      
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" id="modal-cancel" style="flex:1;background:#f2f2f7;color:#333;font-size:14px;border-radius:12px;">
          Отмена
        </button>
        <button class="btn btn-primary" id="modal-pay" style="flex:1;font-size:14px;border-radius:12px;">
          Оплатить
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  let isProcessing = false;

  document.getElementById('modal-cancel').onclick = () => {
    if (!isProcessing) modal.remove();
  };

  document.getElementById('modal-pay').onclick = async function() {
    if (isProcessing) return;
    isProcessing = true;
    
    this.disabled = true;
    this.textContent = '⏳';
    
    const ok = await payForChecklist(checklistId, title);
    
    if (ok) {
      modal.remove();
      if (onSuccess) onSuccess();
    } else {
      modal.remove();
      showPaymentModal(checklistId, title, subtitle, onSuccess);
    }
  };
}

export function getPrice() {
  return CHECKLIST_PRICE;
}

console.log('💰 Payments module loaded');
