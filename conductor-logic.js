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
const driverNameInput = document.getElementById('driverNameInput');
const saveNameBtn = document.getElementById('saveNameBtn');
const nameSavedText = document.getElementById('nameSavedText');
const checkpointBtn = document.getElementById('checkpointBtn');
const checkpointSavedText = document.getElementById('checkpointSavedText');
const toggleBtn = document.getElementById('toggleBtn');
const toggleLabel = document.getElementById('toggleLabel');
const statusText = document.getElementById('statusText');
const coordsText = document.getElementById('coordsText');
const updatedText = document.getElementById('updatedText');
const panicBtn = document.getElementById('panicBtn');
const panicOverlay = document.getElementById('panicOverlay');

let currentDriver = null;
let watchId = null;
let locationChannel = null;
let eventChannel = null;

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
  if (window.lucide) lucide.createIcons();
}

// ----- CIERRE DE SESIÓN -----
function goToPinScreen() {
  if (watchId !== null) stopSharing();
  if (locationChannel) supabase.removeChannel(locationChannel);
  if (eventChannel) supabase.removeChannel(eventChannel);
  localStorage.removeItem('rss_driver_id');
  currentDriver = null;
  mainScreen.classList.add('hidden');
  pinScreen.classList.remove('hidden');
  pinInput.value = '';
}

document.getElementById('backToPinBtn').addEventListener('click', goToPinScreen);

// ----- NOMBRE DEL CONDUCTOR -----
function setupDriverNameField() {
  driverNameInput.value = currentDriver.name || '';
}

saveNameBtn.addEventListener('click', async () => {
  const newName = driverNameInput.value.trim();
  if (!newName) return;

  const { error } = await supabase
    .from('drivers')
    .update({ name: newName })
    .eq('id', currentDriver.id);

  if (!error) {
    nameSavedText.classList.remove('hidden');
    setTimeout(() => nameSavedText.classList.add('hidden'), 3000);
  }
});

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
  checkpointBtn.textContent = CHECKPOINTS[checkpointIdx].label;
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
  const name = driverNameInput.value.trim() || currentDriver.name;

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
}

async function stopSharing() {
  if (Capacitor.isNativePlatform()) {
    await stopSharingNative();
  } else if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
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
