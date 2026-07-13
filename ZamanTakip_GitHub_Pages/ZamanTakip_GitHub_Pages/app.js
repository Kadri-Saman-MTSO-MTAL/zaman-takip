'use strict';

// ------------------------------------------------------------
// Zaman Yönetimi PWA - Ana uygulama kodu
// Firebase Auth + Firestore + çoklu kronometre + raporlama
// ------------------------------------------------------------

const firebaseConfig = {
    apiKey: 'AIzaSyBKuqwQ5lLR1cbMrBc-62qsIL_NXCWRor8',
    authDomain: 'zamantakip-54548.firebaseapp.com',
    projectId: 'zamantakip-54548',
    storageBucket: 'zamantakip-54548.firebasestorage.app',
    messagingSenderId: '241157629151',
    appId: '1:241157629151:web:107403b50bbf90beae756a'
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

// Firestore web istemcisinde çevrimdışı önbelleği etkinleştirir.
// Birden fazla sekmede aynı uygulama açıkken senkron çalışır.
const persistenceReady = db.enablePersistence({ synchronizeTabs: true }).catch((error) => {
    if (error.code === 'failed-precondition') {
        console.warn('Firestore çevrimdışı önbelleği başka bir sekme nedeniyle etkinleştirilemedi.');
    } else if (error.code === 'unimplemented') {
        console.warn('Bu tarayıcı Firestore çevrimdışı önbelleğini desteklemiyor.');
    } else {
        console.warn('Firestore çevrimdışı önbellek hatası:', error);
    }
});

let currentUser = null;
let isSignUpMode = false;
let timerIndex = 0;
const activeTimers = {};
let pastActivitiesArray = [];
let activityChart = null;
let reportRange = '7d';
let reportRecordsCache = [];
let currentAlarmAudio = null;
let vibrationInterval = null;
let wakeLock = null;

const UNLOCK_PIN = '1234';
const TIMER_STORAGE_PREFIX = 'zamanTakip.activeTimers.';

// ------------------------------------------------------------
// Yardımcılar
// ------------------------------------------------------------

function byId(id) {
    return document.getElementById(id);
}

function setAppStatus(message = '', type = 'info') {
    const status = byId('appStatus');
    if (!status) return;
    status.textContent = message;
    status.className = `status-message ${type}`;
    status.hidden = !message;
}

function setAuthMessage(message = '', type = 'info') {
    const status = byId('authMessage');
    if (!status) return;
    status.textContent = message;
    status.className = `auth-message ${type}`;
    status.hidden = !message;
}

function setButtonBusy(button, busy, busyText = 'İşleniyor...') {
    if (!button) return;
    if (busy) {
        button.dataset.originalText = button.textContent;
        button.textContent = busyText;
        button.disabled = true;
    } else {
        button.textContent = button.dataset.originalText || button.textContent;
        button.disabled = false;
    }
}

function getLocalDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseLocalDate(dateString) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateString || '')) return null;
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return [hours, minutes, remainingSeconds]
        .map((value) => String(value).padStart(2, '0'))
        .join(':');
}

function formatDurationReadable(totalSeconds) {
    const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    const parts = [];
    if (hours) parts.push(`${hours} sa`);
    if (minutes) parts.push(`${minutes} dk`);
    if (!hours && !minutes) parts.push(`${remainingSeconds} sn`);
    return parts.join(' ');
}

function getAuthErrorMessage(error) {
    const messages = {
        'auth/invalid-email': 'E-posta adresi geçerli değil.',
        'auth/missing-password': 'Şifre alanı boş bırakılamaz.',
        'auth/weak-password': 'Şifre en az 6 karakter olmalıdır.',
        'auth/email-already-in-use': 'Bu e-posta adresiyle daha önce hesap oluşturulmuş.',
        'auth/user-not-found': 'Bu e-posta adresiyle kayıtlı kullanıcı bulunamadı.',
        'auth/wrong-password': 'Şifre yanlış.',
        'auth/invalid-credential': 'E-posta veya şifre yanlış.',
        'auth/too-many-requests': 'Çok fazla deneme yapıldı. Bir süre sonra tekrar deneyin.',
        'auth/network-request-failed': 'Ağ bağlantısı kurulamadı. İnternet bağlantınızı kontrol edin.'
    };
    return messages[error?.code] || error?.message || 'Beklenmeyen bir hata oluştu.';
}

function getTimerStorageKey() {
    return currentUser ? `${TIMER_STORAGE_PREFIX}${currentUser.uid}` : null;
}

function clearTimerIntervals() {
    Object.values(activeTimers).forEach((timer) => {
        clearInterval(timer.interval);
        clearTimeout(timer.dimTimeout);
        timer.interval = null;
        timer.dimTimeout = null;
    });
}

function clearTimerStateFromPage() {
    clearTimerIntervals();
    Object.keys(activeTimers).forEach((id) => delete activeTimers[id]);
    timerIndex = 0;
    const container = byId('timersContainer');
    if (container) container.innerHTML = '';
}

function syncTimerSeconds(timer) {
    if (timer?.isRunning && Number.isFinite(timer.startTime)) {
        timer.seconds = Math.max(0, Math.floor((Date.now() - timer.startTime) / 1000));
    }
    return timer?.seconds || 0;
}

function persistActiveTimers() {
    const storageKey = getTimerStorageKey();
    if (!storageKey) return;

    const serializable = Object.values(activeTimers).map((timer) => ({
        id: timer.id,
        activity: byId(`input-${timer.id}`)?.value?.trim() || timer.activity || '',
        seconds: syncTimerSeconds(timer),
        isRunning: Boolean(timer.isRunning),
        startTime: timer.isRunning ? timer.startTime : null,
        targetSeconds: timer.targetSeconds,
        alarmTriggered: Boolean(timer.alarmTriggered),
        preWakeTriggered: Boolean(timer.preWakeTriggered),
        createdAt: timer.createdAt || Date.now()
    }));

    try {
        localStorage.setItem(storageKey, JSON.stringify(serializable));
    } catch (error) {
        console.warn('Kronometre durumu tarayıcıya kaydedilemedi:', error);
    }
}

function restoreActiveTimers() {
    clearTimerStateFromPage();
    const storageKey = getTimerStorageKey();
    if (!storageKey) return;

    let savedTimers = [];
    try {
        const raw = localStorage.getItem(storageKey);
        savedTimers = raw ? JSON.parse(raw) : [];
    } catch (error) {
        console.warn('Kaydedilmiş kronometreler okunamadı:', error);
    }

    if (!Array.isArray(savedTimers)) savedTimers = [];

    savedTimers
        .filter((timer) => timer && Number.isFinite(Number(timer.id)))
        .slice(0, 20)
        .forEach((timer) => addNewActivity(timer));

    if (Object.keys(activeTimers).length === 0) addNewActivity();
}

// ------------------------------------------------------------
// Service Worker
// ------------------------------------------------------------

if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            await navigator.serviceWorker.register('./sw.js');
        } catch (error) {
            console.warn('Service Worker kaydedilemedi:', error);
        }
    });
}

// ------------------------------------------------------------
// Authentication
// ------------------------------------------------------------

function toggleAuthMode(event) {
    event?.preventDefault();
    isSignUpMode = !isSignUpMode;

    byId('authTitle').textContent = isSignUpMode ? 'Kayıt Ol' : 'Giriş Yap';
    byId('primaryAuthBtn').textContent = isSignUpMode ? 'Hesap Oluştur' : 'Giriş Yap';
    byId('authSwitchText').innerHTML = isSignUpMode
        ? 'Zaten hesabın var mı? <a href="#" onclick="toggleAuthMode(event)">Giriş Yap</a>'
        : 'Hesabın yok mu? <a href="#" onclick="toggleAuthMode(event)">Kayıt Ol</a>';
    setAuthMessage();
}

async function handleAuth() {
    const email = byId('authEmail').value.trim();
    const password = byId('authPassword').value;
    const button = byId('primaryAuthBtn');

    if (!email || !password) {
        setAuthMessage('E-posta ve şifre alanlarını doldurun.', 'error');
        return;
    }

    setButtonBusy(button, true);
    setAuthMessage();

    try {
        if (isSignUpMode) {
            await auth.createUserWithEmailAndPassword(email, password);
        } else {
            await auth.signInWithEmailAndPassword(email, password);
        }
    } catch (error) {
        setAuthMessage(getAuthErrorMessage(error), 'error');
    } finally {
        setButtonBusy(button, false);
    }
}

async function resetPassword() {
    const email = byId('authEmail').value.trim();
    if (!email) {
        setAuthMessage('Şifre sıfırlama bağlantısı için e-posta adresinizi girin.', 'error');
        return;
    }

    try {
        await auth.sendPasswordResetEmail(email);
        setAuthMessage('Şifre sıfırlama bağlantısı e-posta adresinize gönderildi.', 'success');
    } catch (error) {
        setAuthMessage(getAuthErrorMessage(error), 'error');
    }
}

async function logout() {
    persistActiveTimers();
    try {
        await auth.signOut();
    } catch (error) {
        setAppStatus(`Çıkış yapılamadı: ${getAuthErrorMessage(error)}`, 'error');
    }
}

auth.onAuthStateChanged(async (user) => {
    await persistenceReady;
    stopAlarm();

    if (user) {
        currentUser = user;
        byId('authSection').style.display = 'none';
        byId('appSection').style.display = 'block';
        byId('userEmailDisplay').textContent = user.email || 'Kullanıcı';
        byId('authPassword').value = '';
        setAuthMessage();
        setAppStatus();

        restoreActiveTimers();
        await loadHistoryList();
    } else {
        currentUser = null;
        reportRecordsCache = [];
        pastActivitiesArray = [];
        clearTimerStateFromPage();
        if (activityChart) {
            activityChart.destroy();
            activityChart = null;
        }

        byId('authSection').style.display = 'block';
        byId('appSection').style.display = 'none';
    }
});

// ------------------------------------------------------------
// Sekmeler ve rapor filtreleri
// ------------------------------------------------------------

function switchTab(tabName) {
    const isTimer = tabName === 'timer';
    byId('timerSection').style.display = isTimer ? 'block' : 'none';
    byId('reportsSection').style.display = isTimer ? 'none' : 'block';
    byId('tabTimer').classList.toggle('active', isTimer);
    byId('tabReports').classList.toggle('active', !isTimer);
    byId('tabTimer').setAttribute('aria-selected', String(isTimer));
    byId('tabReports').setAttribute('aria-selected', String(!isTimer));

    if (!isTimer) renderReports(reportRecordsCache);
}

function setReportRange(range) {
    reportRange = range;
    document.querySelectorAll('.filter-btn[data-range]').forEach((button) => {
        button.classList.toggle('active', button.dataset.range === range);
    });
    renderReports(reportRecordsCache);
}

function applyCustomDateRange() {
    const startDate = byId('startDate').value;
    const endDate = byId('endDate').value;

    if (!startDate || !endDate) {
        setAppStatus('Özel tarih aralığı için başlangıç ve bitiş tarihlerini seçin.', 'error');
        return;
    }
    if (startDate > endDate) {
        setAppStatus('Başlangıç tarihi bitiş tarihinden sonra olamaz.', 'error');
        return;
    }

    setAppStatus();
    setReportRange('custom');
}

function getReportDateBounds() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (reportRange === 'all') return { start: null, end: null };

    if (reportRange === 'custom') {
        return {
            start: parseLocalDate(byId('startDate').value),
            end: parseLocalDate(byId('endDate').value)
        };
    }

    const days = reportRange === '30d' ? 30 : 7;
    const start = new Date(today);
    start.setDate(start.getDate() - (days - 1));
    return { start, end: today };
}

function filterRecordsForReport(records) {
    const { start, end } = getReportDateBounds();
    if (!start && !end) return records;

    return records.filter((record) => {
        const date = parseLocalDate(record.date);
        if (!date) return false;
        return (!start || date >= start) && (!end || date <= end);
    });
}

// ------------------------------------------------------------
// Firestore kayıtları, geçmiş ve grafik
// ------------------------------------------------------------

async function fetchUserRecords() {
    if (!currentUser) return [];
    const snapshot = await db.collection('zaman_kayitlari')
        .where('userId', '==', currentUser.uid)
        .get();

    const records = [];
    snapshot.forEach((doc) => {
        const data = doc.data();
        records.push({ id: doc.id, ...data });
    });

    records.sort((a, b) => {
        const aTime = a.timestamp?.toMillis?.() || Date.parse(a.createdAtClient || '') || 0;
        const bTime = b.timestamp?.toMillis?.() || Date.parse(b.createdAtClient || '') || 0;
        return bTime - aTime;
    });

    return records;
}

async function loadHistoryList() {
    const historyList = byId('historyList');
    if (!historyList || !currentUser) return;

    historyList.innerHTML = '<li class="empty-state">Kayıtlar yükleniyor...</li>';

    try {
        const records = await fetchUserRecords();
        reportRecordsCache = records;
        pastActivitiesArray = [...new Set(records
            .map((record) => String(record.activity || '').trim())
            .filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'tr'));

        renderHistoryList(records);
        renderReports(records);
    } catch (error) {
        console.error(error);
        historyList.innerHTML = '<li class="empty-state error">Kayıtlar yüklenemedi.</li>';
        setAppStatus(`Kayıtlar yüklenemedi: ${error.message}`, 'error');
    }
}

function renderHistoryList(records) {
    const historyList = byId('historyList');
    historyList.innerHTML = '';

    if (!records.length) {
        const item = document.createElement('li');
        item.className = 'empty-state';
        item.textContent = 'Henüz tamamlanmış faaliyet kaydı yok.';
        historyList.appendChild(item);
        return;
    }

    records.slice(0, 30).forEach((record) => {
        const item = document.createElement('li');
        item.className = 'history-item';

        const info = document.createElement('div');
        info.className = 'history-info';

        const activity = document.createElement('strong');
        activity.textContent = record.activity || 'Adsız faaliyet';

        const details = document.createElement('span');
        details.className = 'history-date';
        details.textContent = `${record.date || 'Tarihsiz'} · ${formatDuration(record.durationSec)}`;

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'btn-delete';
        deleteButton.textContent = 'Sil';
        deleteButton.addEventListener('click', () => deleteRecord(record.id));

        info.append(activity, details);
        item.append(info, deleteButton);
        historyList.appendChild(item);
    });
}

async function deleteRecord(docId) {
    if (!currentUser || !docId) return;
    if (!window.confirm('Bu faaliyeti tamamen silmek istediğinize emin misiniz?')) return;

    try {
        await db.collection('zaman_kayitlari').doc(docId).delete();
        setAppStatus('Kayıt silindi.', 'success');
        await loadHistoryList();
    } catch (error) {
        setAppStatus(`Silme hatası: ${error.message}`, 'error');
    }
}

async function fetchDataAndRenderChart() {
    if (!currentUser) return;
    try {
        const records = await fetchUserRecords();
        reportRecordsCache = records;
        renderReports(records);
    } catch (error) {
        setAppStatus(`Raporlar yüklenemedi: ${error.message}`, 'error');
    }
}

function renderReports(records) {
    const filteredRecords = filterRecordsForReport(records || []);
    const activityTotals = {};

    filteredRecords.forEach((record) => {
        const activity = String(record.activity || 'Adsız faaliyet').trim() || 'Adsız faaliyet';
        activityTotals[activity] = (activityTotals[activity] || 0) + (Number(record.durationSec) || 0);
    });

    const sorted = Object.entries(activityTotals).sort((a, b) => b[1] - a[1]);
    const totalSeconds = sorted.reduce((sum, [, seconds]) => sum + seconds, 0);

    byId('reportTotal').textContent = `Toplam: ${formatDurationReadable(totalSeconds)}`;
    renderSummaryTable(sorted);
    renderActivityChart(sorted);
}

function renderSummaryTable(sortedActivities) {
    const tableBody = byId('summaryTableBody');
    tableBody.innerHTML = '';

    if (!sortedActivities.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 2;
        cell.className = 'empty-table-cell';
        cell.textContent = 'Seçilen dönemde kayıt bulunamadı.';
        row.appendChild(cell);
        tableBody.appendChild(row);
        return;
    }

    sortedActivities.forEach(([name, seconds]) => {
        const row = document.createElement('tr');
        const nameCell = document.createElement('td');
        const durationCell = document.createElement('td');
        nameCell.textContent = name;
        durationCell.textContent = formatDuration(seconds);
        row.append(nameCell, durationCell);
        tableBody.appendChild(row);
    });
}

function renderActivityChart(sortedActivities) {
    const canvas = byId('activityChart');
    const emptyMessage = byId('chartEmptyMessage');
    if (!canvas) return;

    if (activityChart) {
        activityChart.destroy();
        activityChart = null;
    }

    if (!sortedActivities.length) {
        canvas.hidden = true;
        emptyMessage.hidden = false;
        return;
    }

    canvas.hidden = false;
    emptyMessage.hidden = true;

    if (typeof Chart === 'undefined') {
        emptyMessage.textContent = 'Grafik kütüphanesi yüklenemedi.';
        emptyMessage.hidden = false;
        canvas.hidden = true;
        return;
    }

    activityChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: sortedActivities.map(([name]) => name),
            datasets: [{
                label: 'Toplam süre (dakika)',
                data: sortedActivities.map(([, seconds]) => Number((seconds / 60).toFixed(2))),
                backgroundColor: 'rgba(0, 122, 255, 0.65)',
                borderColor: 'rgba(0, 122, 255, 1)',
                borderWidth: 1,
                borderRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: sortedActivities.length > 6 ? 'y' : 'x',
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => `${context.raw} dk`
                    }
                }
            },
            scales: {
                x: { beginAtZero: true },
                y: { beginAtZero: true }
            }
        }
    });
}

// ------------------------------------------------------------
// Çoklu kronometre
// ------------------------------------------------------------

function addNewActivity(restoredTimer = null) {
    if (!currentUser && !restoredTimer) return;

    const restoredId = Number(restoredTimer?.id);
    const id = Number.isFinite(restoredId) && restoredId > 0 ? restoredId : timerIndex + 1;
    timerIndex = Math.max(timerIndex, id);

    const seconds = Math.max(0, Number(restoredTimer?.seconds) || 0);
    const isRunning = Boolean(restoredTimer?.isRunning);
    const startTime = isRunning
        ? (Number(restoredTimer?.startTime) || Date.now() - seconds * 1000)
        : null;

    activeTimers[id] = {
        id,
        interval: null,
        dimTimeout: null,
        activity: String(restoredTimer?.activity || ''),
        seconds,
        isRunning,
        startTime,
        targetSeconds: Number(restoredTimer?.targetSeconds) || null,
        alarmTriggered: Boolean(restoredTimer?.alarmTriggered),
        preWakeTriggered: Boolean(restoredTimer?.preWakeTriggered),
        createdAt: Number(restoredTimer?.createdAt) || Date.now()
    };

    const container = byId('timersContainer');
    const card = document.createElement('section');
    card.className = 'activity-card';
    card.id = `card-${id}`;
    card.setAttribute('aria-label', `Faaliyet kronometresi ${id}`);

    card.innerHTML = `
        <div class="autocomplete">
            <label class="sr-only" for="input-${id}">Faaliyet adı</label>
            <input type="text" id="input-${id}" class="activity-input" placeholder="Faaliyet adı..." autocomplete="off">
            <div class="autocomplete-items" id="autocomplete-list-${id}" role="listbox"></div>
        </div>
        <div class="timer-controls">
            <div class="timer-display-small" id="display-${id}" aria-live="polite">${formatDuration(seconds)}</div>
            <button type="button" id="toggleBtn-${id}" class="btn-toggle">${isRunning ? 'Durdur' : (seconds > 0 ? 'Devam Et' : 'Başlat')}</button>
            <button type="button" id="alarmBtn-${id}" class="btn-alarm" title="Alarm kur" aria-label="Alarm kur">🔔</button>
            <button type="button" id="finishBtn-${id}" class="btn-finish-small">Bitir</button>
        </div>
    `;

    container.appendChild(card);

    const input = byId(`input-${id}`);
    const toggleButton = byId(`toggleBtn-${id}`);
    const alarmButton = byId(`alarmBtn-${id}`);

    input.value = activeTimers[id].activity;
    input.addEventListener('input', () => {
        activeTimers[id].activity = input.value;
        filterActivities(id);
        persistActiveTimers();
    });
    input.addEventListener('focus', () => filterActivities(id));
    toggleButton.addEventListener('click', () => toggleTimer(id));
    alarmButton.addEventListener('click', () => setSessionAlarm(id));
    byId(`finishBtn-${id}`).addEventListener('click', () => finishTimer(id));

    if (seconds > 0 && !isRunning) toggleButton.classList.add('paused');
    if (activeTimers[id].targetSeconds && !activeTimers[id].alarmTriggered) {
        alarmButton.classList.add('active');
        alarmButton.title = `${Math.ceil(activeTimers[id].targetSeconds / 60)} dakika hedeflendi`;
    }

    if (isRunning) {
        activeTimers[id].interval = window.setInterval(() => updateDisplay(id), 1000);
        updateDisplay(id);
    }

    persistActiveTimers();
    return id;
}

function filterActivities(id) {
    const input = byId(`input-${id}`);
    const listContainer = byId(`autocomplete-list-${id}`);
    if (!input || !listContainer) return;

    const query = input.value.trim().toLocaleLowerCase('tr-TR');
    listContainer.innerHTML = '';
    if (!pastActivitiesArray.length) return;

    const filtered = pastActivitiesArray
        .filter((activity) => activity.toLocaleLowerCase('tr-TR').includes(query))
        .slice(0, 10);

    filtered.forEach((activity) => {
        const item = document.createElement('div');
        item.setAttribute('role', 'option');
        item.tabIndex = 0;

        if (query) {
            const lowerActivity = activity.toLocaleLowerCase('tr-TR');
            const index = lowerActivity.indexOf(query);
            item.append(document.createTextNode(activity.slice(0, index)));
            const strong = document.createElement('strong');
            strong.textContent = activity.slice(index, index + query.length);
            item.append(strong, document.createTextNode(activity.slice(index + query.length)));
        } else {
            item.textContent = activity;
        }

        const chooseActivity = () => {
            input.value = activity;
            activeTimers[id].activity = activity;
            listContainer.innerHTML = '';
            persistActiveTimers();
        };

        item.addEventListener('click', chooseActivity);
        item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                chooseActivity();
            }
        });
        listContainer.appendChild(item);
    });
}

function toggleTimer(id) {
    const timer = activeTimers[id];
    const button = byId(`toggleBtn-${id}`);
    const input = byId(`input-${id}`);
    if (!timer || !button || !input) return;

    const activityName = input.value.trim();
    if (!activityName) {
        window.alert('Kronometreyi başlatmadan önce faaliyet adını girin.');
        input.focus();
        return;
    }

    timer.activity = activityName;

    if (timer.isRunning) {
        syncTimerSeconds(timer);
        clearInterval(timer.interval);
        clearTimeout(timer.dimTimeout);
        timer.interval = null;
        timer.dimTimeout = null;
        timer.isRunning = false;
        timer.startTime = null;
        button.textContent = 'Devam Et';
        button.classList.add('paused');
        releaseWakeLockIfUnused();
    } else {
        timer.startTime = Date.now() - timer.seconds * 1000;
        timer.interval = window.setInterval(() => updateDisplay(id), 1000);
        timer.isRunning = true;
        button.textContent = 'Durdur';
        button.classList.remove('paused');
        byId(`autocomplete-list-${id}`).innerHTML = '';
        updateDisplay(id);

        if (timer.targetSeconds && !timer.alarmTriggered) {
            requestWakeLock();
            requestFullscreen();
            clearTimeout(timer.dimTimeout);
            timer.dimTimeout = window.setTimeout(() => {
                byId('oledSaver').style.display = 'flex';
            }, 3000);
        }
    }

    persistActiveTimers();
}

async function finishTimer(id) {
    const timer = activeTimers[id];
    const input = byId(`input-${id}`);
    const finishButton = byId(`finishBtn-${id}`);
    if (!timer || !input || !currentUser) return;

    syncTimerSeconds(timer);
    const activityName = input.value.trim();

    if (!activityName || timer.seconds === 0) {
        removeTimer(id);
        return;
    }

    const wasRunning = timer.isRunning;
    clearInterval(timer.interval);
    clearTimeout(timer.dimTimeout);
    timer.interval = null;
    timer.dimTimeout = null;
    timer.isRunning = false;
    timer.startTime = null;
    setButtonBusy(finishButton, true, 'Kaydediliyor...');

    const record = {
        userId: currentUser.uid,
        activity: activityName,
        durationStr: formatDuration(timer.seconds),
        durationSec: Math.floor(timer.seconds),
        date: getLocalDateString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        createdAtClient: new Date().toISOString(),
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
    };

    try {
        await db.collection('zaman_kayitlari').add(record);
        removeTimer(id);
        setAppStatus('Faaliyet kaydedildi.', 'success');
        await loadHistoryList();
    } catch (error) {
        setButtonBusy(finishButton, false);
        setAppStatus(`Kayıt hatası: ${error.message}`, 'error');

        if (wasRunning) {
            timer.startTime = Date.now() - timer.seconds * 1000;
            timer.interval = window.setInterval(() => updateDisplay(id), 1000);
            timer.isRunning = true;
            byId(`toggleBtn-${id}`).textContent = 'Durdur';
        }
    }
}

function removeTimer(id, createReplacement = true) {
    const timer = activeTimers[id];
    if (timer) {
        clearInterval(timer.interval);
        clearTimeout(timer.dimTimeout);
    }
    byId(`card-${id}`)?.remove();
    delete activeTimers[id];
    persistActiveTimers();
    releaseWakeLockIfUnused();

    if (createReplacement && Object.keys(activeTimers).length === 0 && currentUser) {
        addNewActivity();
    }
}

function updateDisplay(id) {
    const timer = activeTimers[id];
    const display = byId(`display-${id}`);
    if (!timer || !display) return;

    syncTimerSeconds(timer);
    display.textContent = formatDuration(timer.seconds);

    if (timer.targetSeconds && !timer.alarmTriggered) {
        const remainingSeconds = timer.targetSeconds - timer.seconds;
        if (remainingSeconds <= 5 && remainingSeconds > 0 && !timer.preWakeTriggered) {
            timer.preWakeTriggered = true;
            wakeUpScreen();
        }

        if (timer.seconds >= timer.targetSeconds) {
            timer.alarmTriggered = true;
            byId(`alarmBtn-${id}`)?.classList.remove('active');
            triggerAlarm(byId(`input-${id}`)?.value?.trim() || 'Faaliyet');
        }
    }

    persistActiveTimers();
}

// ------------------------------------------------------------
// Alarm, ekran karartma ve Wake Lock
// ------------------------------------------------------------

function setSessionAlarm(id) {
    const timer = activeTimers[id];
    if (!timer) return;

    const input = window.prompt('Kaç dakika sonra alarm çalsın? (Örnek: 60)', '60');
    if (input === null) return;

    const minutes = Number(String(input).replace(',', '.'));
    if (!Number.isFinite(minutes) || minutes <= 0) {
        window.alert('Geçerli ve sıfırdan büyük bir dakika değeri girin.');
        return;
    }

    timer.targetSeconds = Math.max(1, Math.round(minutes * 60));
    timer.alarmTriggered = false;
    timer.preWakeTriggered = false;

    const alarmButton = byId(`alarmBtn-${id}`);
    alarmButton.classList.add('active');
    alarmButton.title = `${minutes} dakika hedeflendi`;
    persistActiveTimers();

    window.alert('Hedef belirlendi. Kronometre başlatıldığında ekran 3 saniye sonra tasarruf moduna geçecektir.');
}

function triggerAlarm(activityName) {
    stopAlarm();

    currentAlarmAudio = new Audio('./alarm.wav');
    currentAlarmAudio.loop = true;
    currentAlarmAudio.play().catch((error) => {
        console.warn('Alarm sesi tarayıcı tarafından engellendi:', error);
    });

    if ('vibrate' in navigator) {
        navigator.vibrate([1000, 500, 1000]);
        vibrationInterval = window.setInterval(() => {
            navigator.vibrate([1000, 500, 1000]);
        }, 3000);
    }

    byId('alarmModalText').textContent = `${activityName} için hedeflenen süre tamamlandı.`;
    byId('alarmModal').style.display = 'flex';
}

function stopAlarm() {
    if (currentAlarmAudio) {
        currentAlarmAudio.pause();
        currentAlarmAudio.currentTime = 0;
        currentAlarmAudio = null;
    }

    if (vibrationInterval) {
        clearInterval(vibrationInterval);
        vibrationInterval = null;
    }
    if ('vibrate' in navigator) navigator.vibrate(0);

    const modal = byId('alarmModal');
    if (modal) modal.style.display = 'none';
}

function shouldKeepAwake() {
    const oledVisible = byId('oledSaver')?.style.display === 'flex';
    const alarmTimerRunning = Object.values(activeTimers)
        .some((timer) => timer.isRunning && timer.targetSeconds && !timer.alarmTriggered);
    return oledVisible || alarmTimerRunning;
}

async function requestWakeLock() {
    try {
        if (!('wakeLock' in navigator)) return;
        if (wakeLock && !wakeLock.released) return;
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
        });
    } catch (error) {
        console.warn(`Wake Lock hatası: ${error.name} - ${error.message}`);
    }
}

async function releaseWakeLockIfUnused() {
    if (shouldKeepAwake()) return;
    try {
        await wakeLock?.release?.();
    } catch (error) {
        console.warn('Wake Lock bırakılamadı:', error);
    } finally {
        wakeLock = null;
    }
}

function requestFullscreen() {
    const element = document.documentElement;
    const request = element.requestFullscreen || element.webkitRequestFullscreen;
    if (!request || document.fullscreenElement || document.webkitFullscreenElement) return;
    Promise.resolve(request.call(element)).catch((error) => {
        console.warn('Tam ekran açılamadı:', error);
    });
}

function darkenScreen() {
    requestWakeLock();
    byId('oledSaver').style.display = 'flex';
    requestFullscreen();
}

function showPinInput() {
    byId('unlockHint').style.display = 'none';
    byId('unlockForm').style.display = 'flex';
    byId('unlockPin').focus();
}

function hidePinInput() {
    byId('unlockForm').style.display = 'none';
    byId('unlockHint').style.display = 'flex';
    byId('unlockPin').value = '';
}

function checkPin() {
    const enteredPin = byId('unlockPin').value;
    if (enteredPin === UNLOCK_PIN) {
        wakeUpScreen();
    } else {
        window.alert('Hatalı şifre!');
        byId('unlockPin').value = '';
        byId('unlockPin').focus();
    }
}

function wakeUpScreen() {
    byId('oledSaver').style.display = 'none';
    byId('unlockForm').style.display = 'none';
    byId('unlockHint').style.display = 'flex';
    byId('unlockPin').value = '';

    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit && (document.fullscreenElement || document.webkitFullscreenElement)) {
        Promise.resolve(exit.call(document)).catch((error) => {
            console.warn('Tam ekrandan çıkılamadı:', error);
        });
    }
    releaseWakeLockIfUnused();
}

// ------------------------------------------------------------
// Sayfa olayları
// ------------------------------------------------------------

document.addEventListener('click', (event) => {
    if (!event.target.matches('.autocomplete input')) {
        document.querySelectorAll('.autocomplete-items').forEach((list) => {
            list.innerHTML = '';
        });
    }
});

document.addEventListener('visibilitychange', () => {
    Object.keys(activeTimers).forEach((id) => updateDisplay(Number(id)));
    persistActiveTimers();
    if (document.visibilityState === 'visible' && shouldKeepAwake()) requestWakeLock();
});

window.addEventListener('beforeunload', persistActiveTimers);

byId('authEmail').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleAuth();
});
byId('authPassword').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleAuth();
});
byId('unlockPin').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') checkPin();
});

document.querySelectorAll('.filter-btn[data-range]').forEach((button) => {
    button.addEventListener('click', () => setReportRange(button.dataset.range));
});

// Inline HTML olaylarıyla geriye dönük uyumluluk.
Object.assign(window, {
    switchTab,
    loadHistoryList,
    deleteRecord,
    addNewActivity,
    toggleTimer,
    finishTimer,
    setSessionAlarm,
    stopAlarm,
    toggleAuthMode,
    handleAuth,
    resetPassword,
    logout,
    darkenScreen,
    showPinInput,
    hidePinInput,
    checkPin,
    filterActivities,
    fetchDataAndRenderChart,
    applyCustomDateRange
});
