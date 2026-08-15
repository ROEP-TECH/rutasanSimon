import { supabase } from './supabase-config.js';

// Capacitor se inyecta como objeto global (window.Capacitor) dentro de la app nativa.
// Los plugins ya sincronizados quedan disponibles en window.Capacitor.Plugins — no
// se usa "import" de npm porque este proyecto no usa bundler.
const Capacitor = window.Capacitor || { isNativePlatform: () => false, Plugins: {} };
const BackgroundGeolocation = Capacitor.Plugins ? Capacitor.Plugins.BackgroundGeolocation : null;

// Elementos DOM
const pinScreen = document.getElementById('pinScreen');
const mainScreen = document.getElementById('mainScreen');
const pinInput = document.getElementById('pinInput');
const pinError = document.getElementById('pinError');
const checkpointBtn = document.getElementById('checkpointBtn');
const checkpointSavedText = document.getElementById('checkpointSavedText');
const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const statusText = document.getElementById('statusText');
const coordsText = document.getElementById('coordsText');
const updatedText = document.getElementById('updatedText');
const panicBtn = document.getElementById('panicBtn');
const panicOverlay = document.getElementById('panicOverlay');
const headerDriverName = document.getElementById('headerDriverName');
const headerShiftDot = document.getElementById('headerShiftDot');
const nameDisplayRow = document.getElementById('nameDisplayRow');
const checkpointBtnLabel = document.getElementById('checkpointBtnLabel');
const turnoBtn = document.getElementById('turnoBtn');
const turnoReposoStatus = document.getElementById('turnoReposoStatus');
const reposoBtn = document.getElementById('reposoBtn');

let currentDriver = null;
let watchId = null;
let locationChannel = null;
let eventChannel = null;

// Wake Lock: evita que la pantalla se apague sola mientras se comparte
// ubicación. En varios Android, si se apaga la pantalla el sistema es más
// agresivo pausando todo, así que esto ayuda bastante.
// El navegador libera el wake lock automáticamente al ocultar la pestaña,
// por eso lo volvemos a pedir en el listener de "visibilitychange" de abajo.
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (e) {
    console.warn('No se pudo obtener wake lock:', e);
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (e) {
      // no pasa nada si ya se había liberado solo
    }
    wakeLock = null;
  }
}

// Recuperación automática: cuando el chofer regresa a la pestaña (venía de
// otra app, o encendió la pantalla), si la ubicación sigue "encendida" del
// lado de la UI, reforzamos el wake lock por si el navegador lo soltó.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (Capacitor.isNativePlatform()) return;
  if (!toggleBtn.classList.contains('on')) return;

  if (!wakeLock) requestWakeLock();
});

// ----- LOGIN CON PIN -----
document.getElementById('pinSubmit').addEventListener('click', tryPin);
pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryPin(); });

async function tryPin() {
  const pin = pinInput.value.trim();
  if (!pin) return;

  const { data: driver, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('pin', pin)
    .single();

  if (driver && !error) {
    localStorage.setItem('rss_driver_id', driver.id);
    pinError.classList.add('hidden');
    pinInput.value = '';
    unlock(driver);
  } else {
    pinError.classList.remove('hidden');
  }
}

function unlock(driver) {
  currentDriver = driver;
  pinScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  setupDriverNameField();
  setupDriverRoute();
  setupCheckpointButton();
  setupTurnoState();
  setupReposoState();
  if (window.lucide) lucide.createIcons();
}

// ----- CIERRE DE SESIÓN -----
function goToPinScreen() {
  if (watchId !== null) stopSharing();
  if (locationChannel) supabase.removeChannel(locationChannel);
  if (eventChannel) supabase.removeChannel(eventChannel);
  stopReposoCountdown();
  reposoUntil = null;
  localStorage.removeItem('rss_driver_id');
  currentDriver = null;
  mainScreen.classList.add('hidden');
  pinScreen.classList.remove('hidden');
  pinInput.value = '';
}

document.getElementById('backToPinBtn').addEventListener('click', goToPinScreen);

// ----- NOMBRE DEL CONDUCTOR -----
// Solo lectura: el conductor no puede editar su nombre desde este panel.
// Lo asigna el dueño o el checador.
function updateHeaderDriverName() {
  if (!headerDriverName) return;
  const shown = (currentDriver.name || '').trim();
  headerDriverName.textContent = shown || 'Panel del Conductor';
}

function setupDriverNameField() {
  updateHeaderDriverName();
}

// ----- RAMAL ASIGNADO -----
let currentDriverRoute = 'capilla';

function updateRamalButtons() {
  document.querySelectorAll('.ramal-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === currentDriverRoute);
  });
}

function setupDriverRoute() {
  const saved = localStorage.getItem('rss_driver_route_' + currentDriver.id);
  currentDriverRoute = saved || currentDriver.route || 'capilla';
  updateRamalButtons();
}

document.querySelectorAll('.ramal-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    currentDriverRoute = btn.dataset.route;
    updateRamalButtons();
    if (navigator.vibrate) navigator.vibrate(15);
    localStorage.setItem('rss_driver_route_' + currentDriver.id, currentDriverRoute);
    
    const { error } = await supabase
      .from('drivers')
      .update({ route: currentDriverRoute })
      .eq('id', currentDriver.id);

    if (error) console.error('Error actualizando ramal:', error);
  });
});

// ----- CHECKPOINTS (SALIÓ / LLEGÓ) -----
const CHECKPOINTS = [
  { key: 'salio_san_simon',  label: 'Salí de base San Simón' },
  { key: 'llego_san_martin', label: 'Llegué a San Martín' },
  { key: 'salio_san_martin', label: 'Salí de base San Martín' },
  { key: 'llego_san_simon',  label: 'Llegué a San Simón' },
];

let checkpointIdx = 0;
function updateCheckpointButtonLabel() {
  checkpointBtnLabel.textContent = CHECKPOINTS[checkpointIdx].label;
}

function setupCheckpointButton() {
  const saved = localStorage.getItem('rss_checkpoint_idx_' + currentDriver.id);
  const parsed = saved !== null ? parseInt(saved, 10) : 0;
  checkpointIdx = (Number.isInteger(parsed) && parsed >= 0 && parsed < CHECKPOINTS.length) ? parsed : 0;
  updateCheckpointButtonLabel();
}

checkpointBtn.addEventListener('click', async () => {
  if (navigator.vibrate) navigator.vibrate(20);
  const cp = CHECKPOINTS[checkpointIdx];
  const name = currentDriver.name;

  const { error } = await supabase
    .from('route_events')
    .upsert({
      driver_id: currentDriver.id,
      event_key: cp.key,
      label: cp.label,
      route: currentDriverRoute,
      created_at: new Date().toISOString()
    }, { onConflict: 'driver_id' });

  if (!error) {
    checkpointSavedText.classList.remove('hidden');
    setTimeout(() => checkpointSavedText.classList.add('hidden'), 2500);
  } else {
    console.error('Error guardando checkpoint en route_events:', error);
  }

  checkpointIdx = (checkpointIdx + 1) % CHECKPOINTS.length;
  localStorage.setItem('rss_checkpoint_idx_' + currentDriver.id, String(checkpointIdx));
  updateCheckpointButtonLabel();
});

// ----- ESTATUS COMPARTIDO (debajo de Turno/Reposo) -----
// Un solo renglón chiquito: si está en reposo (tiene cuenta regresiva) eso
// manda, porque es lo más urgente/temporal; si no, muestra el estatus del
// turno; si no hay nada que avisar, se oculta para no estorbar la vista.
function renderTurnoReposoStatus() {
  if (!turnoReposoStatus) return;

  if (reposoUntil && reposoUntil.getTime() - Date.now() > 0) {
    const remaining = reposoUntil.getTime() - Date.now();
    turnoReposoStatus.textContent = 'En reposo · vuelve en ' + formatMMSS(remaining) + ' · toca "Reposo" para cancelar';
    turnoReposoStatus.classList.remove('hidden');
  } else if (onShift) {
    turnoReposoStatus.textContent = 'Turno en curso.';
    turnoReposoStatus.classList.remove('hidden');
  } else {
    turnoReposoStatus.classList.add('hidden');
  }
}

// ----- TURNO (INICIAR / TERMINAR) -----
// Es independiente del botón de ubicación: solo lleva registro de cuándo
// el chofer empieza y termina su jornada. NO prende ni apaga el GPS.
// Requiere en Supabase, tabla "drivers": columnas on_shift (bool) y
// shift_started_at (timestamptz).
let onShift = false;

function renderTurnoBtn() {
  if (onShift) {
    turnoBtn.classList.add('on');
    turnoBtn.innerHTML = 'Terminar<br>mi turno';
    if (headerShiftDot) headerShiftDot.classList.remove('hidden');
  } else {
    turnoBtn.classList.remove('on');
    turnoBtn.innerHTML = 'Iniciar<br>mi turno';
    if (headerShiftDot) headerShiftDot.classList.add('hidden');
  }
  renderTurnoReposoStatus();
}

function setupTurnoState() {
  onShift = !!currentDriver.on_shift;
  renderTurnoBtn();
}

turnoBtn.addEventListener('click', async () => {
  if (navigator.vibrate) navigator.vibrate(20);
  const startingShift = !onShift;

  const payload = startingShift
    ? { on_shift: true, shift_started_at: new Date().toISOString() }
    : { on_shift: false };

  const { error } = await supabase
    .from('drivers')
    .update(payload)
    .eq('id', currentDriver.id);

  if (error) {
    console.error('Error actualizando turno:', error);
    return;
  }

  onShift = startingShift;
  currentDriver.on_shift = onShift;
  renderTurnoBtn();
});

// ----- REPOSO (15 MIN) -----
// Nada más es un aviso para el dueño/checador (los pasajeros no lo ven) y
// se quita solo pasados 15 minutos. No afecta la ubicación, que se queda
// prendida todo el tiempo. Requiere en Supabase, tabla "drivers": columna
// resting_until (timestamptz, nullable).
const REPOSO_MINUTES = 15;
let reposoUntil = null;
let reposoIntervalId = null;

function formatMMSS(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function renderReposoBtn() {
  const remaining = reposoUntil ? reposoUntil.getTime() - Date.now() : 0;

  if (reposoUntil && remaining > 0) {
    reposoBtn.classList.add('active');
    reposoBtn.innerHTML = formatMMSS(remaining) + '<br>cancelar';
  } else {
    reposoBtn.classList.remove('active');
    reposoBtn.innerHTML = 'Marcar<br>reposo';
  }
  renderTurnoReposoStatus();
}

function stopReposoCountdown() {
  if (reposoIntervalId !== null) {
    clearInterval(reposoIntervalId);
    reposoIntervalId = null;
  }
}

async function clearReposo() {
  stopReposoCountdown();
  reposoUntil = null;
  renderReposoBtn();
  const { error } = await supabase
    .from('drivers')
    .update({ resting_until: null })
    .eq('id', currentDriver.id);
  if (error) console.error('Error limpiando reposo:', error);
}

function startReposoCountdown() {
  stopReposoCountdown();
  reposoIntervalId = setInterval(() => {
    if (!reposoUntil || reposoUntil.getTime() - Date.now() <= 0) {
      clearReposo();
      return;
    }
    renderReposoBtn();
  }, 1000);
}

function setupReposoState() {
  const saved = currentDriver.resting_until ? new Date(currentDriver.resting_until) : null;
  if (saved && saved.getTime() > Date.now()) {
    reposoUntil = saved;
    renderReposoBtn();
    startReposoCountdown();
  } else {
    reposoUntil = null;
    renderReposoBtn();
  }
}

reposoBtn.addEventListener('click', async () => {
  if (navigator.vibrate) navigator.vibrate(20);

  // Si ya está en reposo, tocar el botón lo cancela antes de tiempo.
  if (reposoUntil) {
    await clearReposo();
    return;
  }

  const until = new Date(Date.now() + REPOSO_MINUTES * 60 * 1000);
  const { error } = await supabase
    .from('drivers')
    .update({ resting_until: until.toISOString() })
    .eq('id', currentDriver.id);

  if (error) {
    console.error('Error marcando reposo:', error);
    return;
  }

  currentDriver.resting_until = until.toISOString();
  reposoUntil = until;
  renderReposoBtn();
  startReposoCountdown();
});

// ----- UBICACIÓN EN VIVO -----
let bgWatcherId = null; // id del watcher nativo (solo se usa dentro de la app empacada)

async function guardarUbicacion(latitude, longitude, heading, speed) {
  const now = Date.now();
  coordsText.textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  updatedText.textContent = new Date(now).toLocaleTimeString('es-MX');

  const { error } = await supabase
    .from('live_locations')
    .upsert({
      driver_id: currentDriver.id,
      lat: latitude,
      lng: longitude,
      heading: heading ?? null,
      speed: speed ?? null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'driver_id' });

  if (error) {
    console.error('Error guardando ubicación en live_locations:', error);
    statusText.textContent = 'No se pudo actualizar tu ubicación (revisa permisos).';
  }
}

// --- Ruta de navegador normal (sin cambios respecto al código original) ---
function onPos(pos) {
  const { latitude, longitude, heading, speed } = pos.coords;
  guardarUbicacion(latitude, longitude, heading, speed);
}

function onPosError(err) {
  let msg = 'No se pudo obtener tu ubicación.';
  if (err.code === err.PERMISSION_DENIED) msg = 'Activa el permiso de ubicación de este sitio.';
  statusText.textContent = msg;
  stopSharing();
}

// --- Ruta nativa (Android empacado con Capacitor) ---
async function startSharingNative() {
  if (!BackgroundGeolocation) {
    console.error('Plugin BackgroundGeolocation no disponible en window.Capacitor.Plugins');
    statusText.textContent = 'No se encontró el módulo de ubicación nativo. Reinstala la app.';
    return;
  }
  try {
    bgWatcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundMessage: 'Ruta San Simón está compartiendo tu ubicación',
        backgroundTitle: 'Compartiendo ubicación',
        requestPermissions: true,
        stale: false,
        distanceFilter: 10, // metros; baja este número si quieres updates más seguidos
      },
      (location, error) => {
        if (error) {
          console.error('Error de background-geolocation:', error);
          if (error.code === 'NOT_AUTHORIZED') {
            statusText.textContent = 'Activa el permiso de ubicación "Todo el tiempo" en Ajustes.';
          } else {
            statusText.textContent = 'No se pudo obtener tu ubicación.';
          }
          stopSharing();
          return;
        }
        if (location) {
          guardarUbicacion(location.latitude, location.longitude, location.bearing, location.speed);
        }
      }
    );

    toggleBtn.classList.add('on');
    toggleLabel.innerHTML = 'Ubicación<br>activa';
    statusText.textContent = 'Los pasajeros ya pueden ver tu combi en el mapa.';
  } catch (e) {
    console.error('No se pudo iniciar background-geolocation:', e);
    statusText.textContent = 'No se pudo activar la ubicación (revisa permisos en Ajustes).';
  }
}

async function stopSharingNative() {
  if (bgWatcherId !== null) {
    try {
      await BackgroundGeolocation.removeWatcher({ id: bgWatcherId });
    } catch (e) {
      console.error('Error quitando watcher nativo:', e);
    }
    bgWatcherId = null;
  }
}

// --- Función pública que usa el botón: decide navegador vs nativo ---
function startSharing() {
  if (navigator.vibrate) navigator.vibrate(20);

  if (Capacitor.isNativePlatform()) {
    startSharingNative();
    return;
  }

  // Navegador normal (sin cambios)
  if (!navigator.geolocation) {
    statusText.textContent = 'Tu navegador no soporta geolocalización.';
    return;
  }

  toggleBtn.classList.add('on');
  toggleLabel.innerHTML = 'Ubicación<br>activa';
  statusText.textContent = 'Los pasajeros ya pueden ver tu combi en el mapa.';

  watchId = navigator.geolocation.watchPosition(onPos, onPosError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 15000,
  });

  requestWakeLock();
}

async function stopSharing() {
  if (Capacitor.isNativePlatform()) {
    await stopSharingNative();
  } else if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    releaseWakeLock();
  }

  toggleBtn.classList.remove('on');
  toggleLabel.innerHTML = 'Encender<br>ubicación';
  statusText.textContent = 'Presiona el botón para que los pasajeros vean tu combi.';

  const { error } = await supabase
    .from('live_locations')
    .update({ updated_at: null })
    .eq('driver_id', currentDriver.id);

  if (error) {
    console.error('Error apagando ubicación en live_locations:', error);
  }
}

toggleBtn.addEventListener('click', () => {
  if (toggleBtn.classList.contains('on')) stopSharing();
  else startSharing();
});

// ----- BOTÓN DE AYUDA / PÁNICO -----
function openPanic() { panicOverlay.classList.add('show'); }
function closePanic() { panicOverlay.classList.remove('show'); }

panicBtn.addEventListener('click', () => {
  if (navigator.vibrate) navigator.vibrate(20);
  openPanic();
});

document.getElementById('panicCancelBtn').addEventListener('click', closePanic);
document.getElementById('panicCloseBtn').addEventListener('click', closePanic);
document.getElementById('panicErrorCloseBtn').addEventListener('click', closePanic);
panicOverlay.addEventListener('click', (e) => {
  if (e.target.id === 'panicOverlay') closePanic();
});

document.getElementById('panicConfirmBtn').addEventListener('click', () => {
  if (navigator.vibrate) navigator.vibrate([40, 30, 40, 30, 60]);
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => sendPanicAlert(pos.coords.latitude, pos.coords.longitude),
      () => sendPanicAlert(null, null),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  } else {
    sendPanicAlert(null, null);
  }
});

async function sendPanicAlert(lat, lng) {
  const { error } = await supabase
    .from('panic_alerts')
    .insert({
      driver_id: currentDriver.id,
      owner_id: currentDriver.owner_id,
      lat: lat,
      lng: lng,
      status: 'pendiente'
    });

  if (!error) {
    document.getElementById('panicStepAsk').classList.add('hidden');
    document.getElementById('panicStepSent').classList.remove('hidden');
  } else {
    console.error('Error enviando alerta de pánico:', error);
    document.getElementById('panicStepAsk').classList.add('hidden');
    document.getElementById('panicStepError').classList.remove('hidden');
  }
}
