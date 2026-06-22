import { loadCategories, loadChecklists } from './api.js';
import { isPaid, needsPayment, showPaymentModal, getPrice } from './payments.js';

const app = document.getElementById('app');
const WORKER_URL = 'https://checklistings.dan-svistunov.workers.dev';

let state = {
  screen: 'categories',
  categories: [],
  category: null,
  checklists: [],
  current: null
};

// STORAGE
const getProgress = () => {
  try { return JSON.parse(localStorage.getItem('progress') || '{}'); }
  catch { return {}; }
};

const getOpened = () => {
  try { return JSON.parse(localStorage.getItem('opened') || '{}'); }
  catch { return {}; }
};

const setDone = (id) => {
  const p = getProgress();
  p[id] = true;
  localStorage.setItem('progress', JSON.stringify(p));
};

const setOpened = (id) => {
  const o = getOpened();
  o[id] = true;
  localStorage.setItem('opened', JSON.stringify(o));
};

function getLevel(percent) {
  if (percent < 20) return 'Новичок';
  if (percent < 50) return 'Любитель';
  if (percent < 80) return 'Продвинутый';
  return 'Мастер';
}

async function trackUser() {
  try {
    if (window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      const user = tg.initDataUnsafe?.user;
      
      if (user?.id) {
        fetch(`${WORKER_URL}/api/track-user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: user.id,
            username: user.username || '',
            first_name: user.first_name || ''
          })
        }).catch(() => {});

        fetch(`${WORKER_URL}/api/track-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: user.id,
            event: 'app_open',
            data: { platform: tg.platform, version: tg.version }
          })
        }).catch(() => {});
      }
    }
  } catch (e) {}
}

async function trackChecklistComplete(checklistId, checklistTitle) {
  try {
    if (window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      const user = tg.initDataUnsafe?.user;
      
      if (user?.id) {
        fetch(`${WORKER_URL}/api/track-progress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: user.id,
            checklist_id: checklistId,
            checklist_title: checklistTitle
          })
        }).catch(() => {});
      }
    }
  } catch (e) {}
}

// INIT
async function init() {
  try {
    await trackUser();
    state.categories = await loadCategories();
    render();
  } catch (e) {
    console.error('Init error:', e);
    app.innerHTML = '<p style="text-align:center;padding:40px;">Ошибка загрузки</p>';
  }
}

function render() {
  if (state.screen === 'categories') renderCategories();
  else if (state.screen === 'list') renderList();
  else if (state.screen === 'check') renderCheck();
}

async function renderCategories() {
  const progress = getProgress();
  const categoriesWithProgress = await Promise.all(
    state.categories.map(async (c) => {
      const lists = await loadChecklists(c.id);
      const total = lists.length;
      const done = lists.filter(l => progress[l.id]).length;
      const percent = total ? Math.round(done / total * 100) : 0;
      return { ...c, percent };
    })
  );

  const percent = Math.round(
    categoriesWithProgress.reduce((acc, c) => acc + c.percent, 0) / categoriesWithProgress.length
  );
  const level = getLevel(percent);
  categoriesWithProgress.sort((a, b) => b.percent - a.percent);

  app.innerHTML = `
    <h1>Чек-листы!</h1>
    <div class="dashboard">
      <div class="dashboard-title">Ваш прогресс</div>
      <div class="dashboard-level">${level}</div>
      <div class="dashboard-bar"><div class="dashboard-fill" style="width:${percent}%"></div></div>
      <div style="margin-top:6px;">${percent}% завершено</div>
    </div>
    ${categoriesWithProgress.map(c => `
      <div class="card category" onclick="openCategory('${c.id}')">
        <div class="category-header">
          <div>
            <div class="category-title">${c.icon} ${c.title}</div>
            <div style="font-size:13px;color:#666;margin-top:4px;">${c.description}</div>
          </div>
          <div class="category-percent">${c.percent}%</div>
        </div>
        <div class="progress-bar" style="margin-top:8px;"><div class="progress-fill" style="width:${c.percent}%"></div></div>
      </div>
    `).join('')}
  `;
}

window.openCategory = async (id) => {
  try {
    state.category = state.categories.find(c => c.id === id);
    state.checklists = await loadChecklists(id);
    state.screen = 'list';
    render();
  } catch (e) {
    console.error('Error:', e);
  }
};

function getStatus(id) {
  const progress = getProgress();
  const opened = getOpened();
  if (progress[id]) return { text: 'Выполнен', class: 'done' };
  if (opened[id]) return { text: 'Не завершен', class: 'progress' };
  return { text: 'Новый', class: 'new' };
}

function renderList() {
  const price = getPrice();
  const cat = state.category;

  const sorted = [...state.checklists].sort((a, b) => {
    const statusA = getStatus(a.id);
    const statusB = getStatus(b.id);
    const lockedA = needsPayment(a, cat);
    const lockedB = needsPayment(b, cat);
    
    const getPriority = (status, locked) => {
      if (status.class === 'progress') return 0;
      if (status.class === 'new' && !locked) return 1;
      if (status.class === 'new' && locked) return 2;
      return 3;
    };
    
    return getPriority(statusA, lockedA) - getPriority(statusB, lockedB);
  });

  app.innerHTML = `
    <button class="btn btn-ghost" onclick="goBack()">← Назад</button>
    <h2 style="margin-top:8px;">${cat.icon} ${cat.title}</h2>
    <p style="font-size:13px;color:#666;margin-bottom:16px;">${cat.description}</p>
    ${sorted.map(c => {
      const s = getStatus(c.id);
      const locked = needsPayment(c, cat);
      return `
        <div class="card" onclick="${locked ? `window.showPay('${c.id}', '${c.title.replace(/'/g, "\\'")}')` : `openChecklist('${c.id}')`}">
          <div class="card-row">
            <div>
              <div style="font-weight:700;font-size:16px;">${locked ? '🔒 ' : '📖 '}${c.title}</div>
              ${c.subtitle ? `<div class="checklist-subtitle">${c.subtitle}</div>` : ''}
            </div>
            <div style="text-align:right;">
              <div class="status ${s.class}">${s.text}</div>
              ${locked ? `<div style="font-size:13px;font-weight:600;color:#ff9500;margin-top:4px;white-space:nowrap;display:flex;align-items:center;justify-content:flex-end;">${price}<span style="font-size:9px;">⭐</span></div>` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('')}
  `;

  // Прокрутка вверх страницы
  window.scrollTo(0, 0);
}

window.showPay = (id, title) => {
  const checklist = state.checklists.find(c => c.id === id);
  const subtitle = checklist?.subtitle || '';
  showPaymentModal(id, title, subtitle, () => openChecklist(id));
};

window.openChecklist = (id) => {
  setOpened(id);
  state.current = state.checklists.find(x => x.id === id);
  state.screen = 'check';
  
  // Трекинг открытия
  try {
    if (window.Telegram?.WebApp) {
      const tg = window.Telegram.WebApp;
      const user = tg.initDataUnsafe?.user;
      if (user?.id) {
        fetch(`${WORKER_URL}/api/track-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: user.id,
            event: 'checklist_open',
            data: {
              checklist_id: id,
              checklist_title: state.current?.title || id,
              category_id: state.category?.id || '',
              category_title: state.category?.title || '',
              category_icon: state.category?.icon || ''
            }
          })
        }).catch(() => {});
      }
    }
  } catch (e) {}
  
  render();
};

function renderCheck() {
  const c = state.current;
  app.innerHTML = `
    <button class="btn btn-ghost" onclick="goBack()">← Назад</button>
    <h2>${c.title}</h2>
    ${c.description ? `<div class="checklist-description">${c.description}</div>` : ''}
    ${(c.items || []).map((item, i) => `
      <div class="item">
        <div class="item-header" onclick="toggle(${i})">${item.emoji} ${item.title}</div>
        <div class="item-body" id="i${i}">
          <p>${item.text}</p>
          ${item.source ? `<div style="font-size:12px;color:#888;margin-top:8px;">📚 ${item.source}</div>` : ''}
          ${item.tip ? `<div style="margin-top:8px;padding:10px;background:#f2f2f7;border-radius:10px;font-size:13px;">💡 ${item.tip}</div>` : ''}
        </div>
      </div>
    `).join('')}
    ${renderQuiz(c)}
  `;
}

window.toggle = (i) => {
  const items = document.querySelectorAll('.item');
  const body = document.getElementById('i' + i);
  if (!items[i] || !body) return;
  const isOpen = body.style.display === 'block';
  body.style.display = isOpen ? 'none' : 'block';
  items[i].classList.toggle('open');
};

function renderQuiz(c) {
  if (!c.quiz || !c.quiz.length) return '';
  return `
    <div class="quiz-section">
      <div class="quiz-title">🧠 Мини-тест</div>
      ${c.quiz.map((q, i) => `
        <div class="quiz-question">
          <p>${q.q}</p>
          ${q.a.map((a, j) => `<label class="quiz-option"><input type="radio" name="q${i}" value="${j}"> ${a}</label>`).join('')}
        </div>
      `).join('')}
      <div style="text-align:center;margin-top:12px;"><button class="btn btn-primary" onclick="checkQuiz()">Проверить</button></div>
    </div>
  `;
}

window.checkQuiz = () => {
  const c = state.current;
  let score = 0;
  let all = true;
  
  c.quiz.forEach((q, i) => {
    const v = document.querySelector(`input[name="q${i}"]:checked`);
    if (!v) all = false;
    if (v && Number(v.value) === q.correct) score++;
  });

  if (!all) { alert('Ответьте на все вопросы'); return; }

  const modal = document.createElement('div');
  modal.className = 'modal';
  const ok = score === c.quiz.length;
  if (ok) {
    setDone(c.id);
    trackChecklistComplete(c.id, c.title);
  }

  modal.innerHTML = ok ? `
    <div class="modal-content">
      <h3>🎉 Отлично!</h3><p>${score}/${c.quiz.length}</p>
      <p>Ты прошёл чек-лист 🚀</p>
      <button class="btn btn-primary" onclick="closeModal(true)">Завершить</button>
    </div>
  ` : `
    <div class="modal-content">
      <h3>Результат</h3><p>${score}/${c.quiz.length}</p>
      <p>Попробуй ещё раз 🎯</p>
      <button class="btn btn-primary" onclick="closeModal(false)">Вернуться</button>
    </div>
  `;
  
  document.body.appendChild(modal);
};

window.closeModal = (done) => {
  const m = document.querySelector('.modal');
  if (m) m.remove();
  if (done) goBack();
};

window.goBack = () => {
  if (state.screen === 'check') state.screen = 'list';
  else state.screen = 'categories';
  render();
};

init();
