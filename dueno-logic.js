import { supabase } from './supabase-config.js';

let currentUser = null;
let currentOwner = null;
let map = null;
let driverMarkers = {};
let locationChannel = null;
let routeChannel = null;
let alertChannel = null;
let checadorEventsChannel = null;
let mapInitialized = false; // Evita que el mapa se duplique

// Caché en memoria de la última carga, para alimentar el drawer y las búsquedas sin volver a pedir datos
let lastDrivers = [];
let lastChecadorEvents = [];
let driverSearchTerm = '';

// Elementos DOM
const loginScreen = document.getElementById('loginScreen');
const mainScreen = document.getElementById('mainScreen');
const emailInput = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginError = document.getElementById('loginError');

// ----- LOGIN CON CORREO Y CONTRASEÑA -----
document.getElementById('loginSubmit').addEventListener('click', tryLogin);
emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });
passwordInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryLogin(); });

async function tryLogin() {
  const email = emailInput.value.trim();
  const password = passwordInput.value.trim();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email,
    password: password,
  });

  if (error || !data.user) {
    loginError.classList.remove('hidden');
    return;
  }

  const { data: owner, error: ownerError } = await supabase
    .from('owners')
    .select('*')
    .eq('id', data.user.id)
    .single();

  if (ownerError || !owner) {
    loginError.textContent = 'Tu cuenta no está registrada como dueño.';
    loginError.classList.remove('hidden');
    return;
  }

  currentUser = data.user;
  currentOwner = owner;
  loginError.classList.add('hidden');
  loginScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  mainScreen.classList.add('md:flex');

  // Inicializar mapa SOLO si no se ha creado antes
  if (!mapInitialized) {
    initMap();
  }

  initRealtimeListeners();
  if (window.lucide) lucide.createIcons();
}

// ----- CIERRE DE SESIÓN -----
async function doLogout() {
  await supabase.auth.signOut();
  if (locationChannel) supabase.removeChannel(locationChannel);
  if (routeChannel) supabase.removeChannel(routeChannel);
  if (alertChannel) supabase.removeChannel(alertChannel);
  if (checadorEventsChannel) supabase.removeChannel(checadorEventsChannel);
  currentUser = null;
  currentOwner = null;
  mapInitialized = false; // Reiniciamos el flag al cerrar sesión
  lastDrivers = [];
  lastChecadorEvents = [];
  closeDriverDrawer();
  mainScreen.classList.add('hidden');
  mainScreen.classList.remove('md:flex');
  loginScreen.classList.remove('hidden');
  emailInput.value = '';
  passwordInput.value = '';
}
document.getElementById('logoutBtn').addEventListener('click', doLogout);
document.getElementById('logoutBtnDesktop').addEventListener('click', doLogout);

// ----- BUSCADOR DE CONDUCTORES -----
const driverSearchInput = document.getElementById('driverSearchInput');
const driverSearchInputMobile = document.getElementById('driverSearchInputMobile');
function onDriverSearch(e) {
  driverSearchTerm = e.target.value.trim().toLowerCase();
  // Mantenemos ambos campos sincronizados (escritorio/móvil)
  if (driverSearchInput && driverSearchInput.value !== e.target.value) driverSearchInput.value = e.target.value;
  if (driverSearchInputMobile && driverSearchInputMobile.value !== e.target.value) driverSearchInputMobile.value = e.target.value;
  renderDriversList();
}
if (driverSearchInput) driverSearchInput.addEventListener('input', onDriverSearch);
if (driverSearchInputMobile) driverSearchInputMobile.addEventListener('input', onDriverSearch);

// ----- MAPA (Leaflet) -----
function initMap() {
  if (mapInitialized) return; // Si ya existe, no hacer nada

  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([19.272, -98.455], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  L.control.attribution({ prefix: false })
    .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
    .addTo(map);

  mapInitialized = true; // Marcamos que ya se creó
}

function routeLabelFor(route) {
  return route === 'capilla' ? 'Por Capilla' : route === 'secundaria' ? 'Por Secundaria' : 'Sin ramal';
}
function routeColorFor(route) {
  return route === 'capilla' ? 'var(--cempasuchil)' : route === 'secundaria' ? 'var(--agave)' : 'var(--ink-faint)';
}

function driverIcon(route) {
  const color = route === 'secundaria' ? '#2FD98A' : (route === 'capilla' ? '#FFAE33' : '#3FB0F0');
  return L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;border-radius:50%;background:${color};border:3px solid #11161D;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 10px rgba(0,0,0,.6);">🚐</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

// ----- MENSAJE FLOTANTE (TOAST) -----
let toastTimeout = null;
function showToast(message) {
  let toast = document.getElementById('rssToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'rssToast';
    toast.style.cssText = `
      position:fixed; left:50%; bottom:28px; transform:translateX(-50%) translateY(20px);
      background:var(--surface-3); color:var(--ink); border:1px solid var(--border);
      font-family:'Plus Jakarta Sans', sans-serif;
      font-size:13px; font-weight:600; padding:10px 16px; border-radius:999px;
      box-shadow:0 10px 30px -10px rgba(0,0,0,.6); z-index:200; opacity:0;
      transition:opacity .25s ease, transform .25s ease; pointer-events:none; max-width:85vw;
      text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  clearTimeout(toastTimeout);

  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
  });

  toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 2200);
}

// ----- CENTRAR MAPA EN UN CONDUCTOR ESPECÍFICO -----
function goToDriverOnMap(driverId) {
  const marker = driverMarkers[driverId];
  if (!map || !marker) return;

  map._rssCentered = true; // evita que el auto-ajuste general le gane a este zoom
  map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.75 });
  marker.openPopup();

  const mapEl = document.getElementById('map');
  if (mapEl) mapEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ----- DRAWER: FICHA RÁPIDA DEL CONDUCTOR -----
const driverDrawer = document.getElementById('driverDrawer');
const driverDrawerOverlay = document.getElementById('driverDrawerOverlay');
const driverDrawerContent = document.getElementById('driverDrawerContent');

function openDriverDrawer(driverId) {
  const d = lastDrivers.find(x => x.id === driverId);
  if (!d) return;

  const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
  const fresh = location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);

  const todaysEvents = lastChecadorEvents.filter(ev => ev.driver_id === d.id || ev.driver?.name === d.name);

  const statusInfo = {
    a_tiempo: { label: 'A tiempo', icon: 'check-circle-2', color: 'var(--agave)' },
    retraso: { label: 'Llegó tarde', icon: 'clock', color: 'var(--cempasuchil)' },
    no_se_presento: { label: 'No se presentó', icon: 'alert-triangle', color: 'var(--alerta)' },
  };

  const eventsHtml = todaysEvents.length
    ? todaysEvents.map(ev => {
        const info = statusInfo[ev.status] || { label: ev.status || '—', icon: 'circle', color: 'var(--ink-soft)' };
        const time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
        return `
          <div class="flex items-center gap-2.5 py-1.5">
            <span class="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, ${info.color} 16%, var(--surface)); color:${info.color};"><i data-lucide="${info.icon}" class="w-3.5 h-3.5"></i></span>
            <p class="text-xs" style="color:var(--ink-soft);"><span class="font-semibold" style="color:${info.color};">${info.label}</span> · ${time}${ev.ubicacion ? ' · ' + ev.ubicacion : ''}</p>
          </div>`;
      }).join('')
    : `<p class="text-xs" style="color:var(--ink-faint);">Sin registros del checador hoy.</p>`;

  let locText = 'Sin conexión';
  if (fresh) {
    locText = `📍 ${location.lat.toFixed(5)}, ${location.lng.toFixed(5)} · ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
  } else if (location && location.updated_at) {
    locText = `Última vez: ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
  }

  driverDrawerContent.innerHTML = `
    <div class="flex items-center gap-3">
      <span class="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 font-display font-bold text-lg" style="background:color-mix(in srgb, var(--talavera) 16%, var(--surface)); color:var(--talavera);">${(d.name || '?').trim().charAt(0).toUpperCase()}</span>
      <div class="min-w-0">
        <p class="font-display font-semibold text-base truncate">${d.name}</p>
        <p class="text-xs font-mono" style="color:var(--ink-soft);">Unidad ${d.unit?.unit_number || '?'}</p>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <span class="text-[11px] font-semibold px-2.5 py-1 rounded-full" style="background:${routeColorFor(d.route)}; color:#08131c;">${routeLabelFor(d.route)}</span>
      <span class="flex items-center gap-1.5 text-xs font-semibold" style="color:var(--ink-soft);"><span class="status-dot ${fresh ? 'on' : 'off'}"></span> ${fresh ? 'En ruta' : 'Sin conexión'}</span>
    </div>

    <div class="card-soft p-3">
      <p class="text-[10px] font-mono uppercase tracking-wide mb-1" style="color:var(--ink-faint);">Última ubicación</p>
      <p class="text-xs font-mono" style="color:var(--ink-soft);">${locText}</p>
    </div>

    <div>
      <p class="text-[10px] font-mono uppercase tracking-wide mb-1.5" style="color:var(--ink-faint);">Checador hoy</p>
      <div class="card-soft p-3">${eventsHtml}</div>
    </div>

    <div class="flex gap-2 pt-1">
      <button id="drawerGoToMap" class="btn-lift flex-1 text-xs font-semibold px-3.5 py-2.5 rounded-full flex items-center justify-center gap-1.5" style="background:var(--talavera); color:#08131c;" ${fresh ? '' : 'disabled'}>
        <i data-lucide="map-pin" class="w-3.5 h-3.5"></i> Ver en el mapa
      </button>
    </div>
    ${!fresh ? `<p class="text-[11px] text-center" style="color:var(--ink-faint);">Este conductor no tiene ubicación en vivo disponible.</p>` : ''}
  `;

  const goBtn = document.getElementById('drawerGoToMap');
  if (goBtn && fresh) {
    goBtn.addEventListener('click', () => {
      closeDriverDrawer();
      goToDriverOnMap(d.id);
    });
  } else if (goBtn) {
    goBtn.style.opacity = '.5';
    goBtn.style.cursor = 'not-allowed';
  }

  driverDrawer.classList.remove('hidden');
  driverDrawerOverlay.classList.remove('hidden');
  // Forzamos reflow para que la transición de apertura se anime siempre, incluso si ya estaba montado
  void driverDrawer.offsetHeight;
  driverDrawer.classList.add('open');
  if (window.lucide) lucide.createIcons();
}

let drawerCloseTimeout = null;
function closeDriverDrawer() {
  driverDrawer.classList.remove('open');
  driverDrawerOverlay.classList.add('hidden');
  clearTimeout(drawerCloseTimeout);
  drawerCloseTimeout = setTimeout(() => {
    driverDrawer.classList.add('hidden');
  }, 300);
}
document.getElementById('driverDrawerClose').addEventListener('click', closeDriverDrawer);
driverDrawerOverlay.addEventListener('click', closeDriverDrawer);

// ----- ESCUCHAR DATOS EN TIEMPO REAL -----
function initRealtimeListeners() {
  locationChannel = supabase
    .channel('locations-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_locations' },
      () => { renderDriversAndMap(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] live_locations:', status, err || '');
    });

  routeChannel = supabase
    .channel('route-events-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'route_events' },
      () => { renderRouteEvents(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] route_events:', status, err || '');
    });

  alertChannel = supabase
    .channel('alerts-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'panic_alerts' },
      () => { renderAlerts(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] panic_alerts:', status, err || '');
    });

  checadorEventsChannel = supabase
    .channel('checador-events-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'checador_events' },
      () => { renderChecadorEvents(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] checador_events:', status, err || '');
    });

  // Carga inicial
  renderDriversAndMap();
  renderRouteEvents();
  renderAlerts();
  renderChecadorEvents();
}

// ----- RENDERIZAR CONDUCTORES Y MAPA (CON FILTRO ADMIN/OWNER) -----
async function renderDriversAndMap() {
  if (!currentOwner) return;

  const isAdmin = currentOwner.role === 'admin';

  let query = supabase
    .from('drivers')
    .select(`
      *,
      unit:unit_id ( unit_number ),
      live_location:live_locations ( lat, lng, heading, speed, updated_at )
    `);

  if (!isAdmin) {
    query = query.eq('owner_id', currentOwner.id);
  }

  const { data: drivers, error } = await query;

  if (error) {
    console.error("Error al cargar conductores:", error);
    return;
  }

  lastDrivers = drivers || [];
  renderDriversList();
  renderFleetPulse();
}

// ----- LISTA DE CONDUCTORES (separado para poder filtrar por búsqueda sin recargar datos) -----
function renderDriversList() {
  const list = document.getElementById('driversList');
  const emptyMsg = document.getElementById('driversEmpty');
  list.innerHTML = '';

  const term = driverSearchTerm;
  const visibleDrivers = term
    ? lastDrivers.filter(d => (d.name || '').toLowerCase().includes(term))
    : lastDrivers;

  let onlineCount = 0;
  let capillaCount = 0;
  let secundariaCount = 0;

  // Recalculamos siempre sobre el total (no solo lo filtrado) para que el contador sea real
  lastDrivers.forEach(d => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at &&
      (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);
    if (fresh) onlineCount++;
    if (d.route === 'capilla') capillaCount++;
    else if (d.route === 'secundaria') secundariaCount++;
  });

  document.getElementById('driversOnlineCount').textContent =
    onlineCount + ' en ruta · ' + capillaCount + ' Capilla · ' + secundariaCount + ' Sec.';
  document.getElementById('kpiOnRoute').textContent = `${onlineCount}/${lastDrivers.length}`;
  document.getElementById('liveBadgeText').textContent = `${onlineCount} en ruta`;

  if (visibleDrivers.length === 0) {
    emptyMsg.classList.remove('hidden');
  } else {
    emptyMsg.classList.add('hidden');
  }

  visibleDrivers.forEach(d => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at &&
      (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);

    const routeLabel = routeLabelFor(d.route);
    const routeColor = routeColorFor(d.route);

    let locText = 'Sin conexión';
    if (fresh) {
      const lat = location.lat.toFixed(5);
      const lng = location.lng.toFixed(5);
      locText = `📍 ${lat}, ${lng} · ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
    } else if (location && location.updated_at) {
      locText = `Última vez: ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
    }

    const row = document.createElement('div');
    row.className = 'driver-row py-3 flex items-center justify-between gap-1.5 sm:gap-2 cursor-pointer';
    row.dataset.driverId = d.id;

    row.innerHTML = `
      <div class="min-w-0 flex items-center gap-2 sm:gap-2.5 flex-1">
        <span class="w-8 h-8 sm:w-9 sm:h-9 rounded-full flex items-center justify-center shrink-0 font-display font-bold text-sm" style="background:color-mix(in srgb, var(--talavera) 16%, var(--surface)); color:var(--talavera);">${(d.name || '?').trim().charAt(0).toUpperCase()}</span>
        <div class="min-w-0">
          <p class="font-display font-semibold text-sm truncate">${d.name} <span class="text-[10px] font-mono" style="color:var(--ink-soft);">(U.${d.unit?.unit_number || '?'})</span></p>
          <p class="text-[10px] sm:text-[11px] font-mono truncate" style="color:var(--ink-soft);">${locText}</p>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full mt-1 inline-block" style="background:${routeColor}; color:#08131c;">${routeLabel}</span>
        </div>
      </div>
      <span class="flex items-center gap-1.5 sm:gap-2.5 text-xs font-semibold shrink-0">
        <span class="hidden sm:flex items-center gap-1.5"><span class="status-dot ${fresh ? 'on' : 'off'}"></span> ${fresh ? 'En ruta' : 'Sin conexión'}</span>
        <span class="status-dot sm:hidden ${fresh ? 'on' : 'off'}"></span>
        <button class="driver-map-btn btn-lift w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:var(--surface-2); border:1px solid var(--border); color:var(--talavera);" title="Ver en el mapa">
          <i data-lucide="map-pin" class="w-3.5 h-3.5"></i>
        </button>
      </span>
    `;

    // Click en la fila: abre la ficha rápida (drawer)
    row.addEventListener('click', () => openDriverDrawer(d.id));

    // Click en el botón de mapa: va directo al mapa (o avisa si no hay ubicación)
    const mapBtn = row.querySelector('.driver-map-btn');
    mapBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fresh) {
        goToDriverOnMap(d.id);
      } else {
        showToast(`${d.name}: sin ubicación disponible.`);
      }
    });

    list.appendChild(row);

    if (fresh && location && location.lat && location.lng) {
      const latlng = [location.lat, location.lng];
      if (!driverMarkers[d.id]) {
        driverMarkers[d.id] = L.marker(latlng, { icon: driverIcon(d.route) }).addTo(map).bindPopup(`${d.name} · ${routeLabel}`);
      } else {
        driverMarkers[d.id].setLatLng(latlng);
        driverMarkers[d.id].setPopupContent(`${d.name} · ${routeLabel}`);
      }
    } else if (driverMarkers[d.id]) {
      map.removeLayer(driverMarkers[d.id]);
      delete driverMarkers[d.id];
    }
  });

  const activeMarkers = Object.values(driverMarkers);
  if (activeMarkers.length > 0 && !map._rssCentered) {
    const group = L.featureGroup(activeMarkers);
    map.fitBounds(group.getBounds().pad(0.2));
    map._rssCentered = true;
  }

  if (window.lucide) lucide.createIcons();
}

// ----- FRANJA DE PULSO DE FLOTA -----
function renderFleetPulse() {
  const rail = document.getElementById('fleetPulse');
  const countEl = document.getElementById('fleetPulseCount');
  if (!rail) return;

  const online = lastDrivers.filter(d => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    return location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);
  });

  countEl.textContent = `${online.length}/${lastDrivers.length} activas`;

  if (online.length === 0) {
    rail.innerHTML = `<p class="text-xs px-1" style="color:var(--ink-faint);">Ninguna unidad en ruta por ahora.</p>`;
    return;
  }

  rail.innerHTML = online.map(d => `
    <button class="pulse-chip flex items-center gap-1.5 px-3 py-1.5" data-driver-id="${d.id}">
      <span class="status-dot on pulse-live"></span>
      <span class="text-xs font-semibold">${d.name}</span>
      <span class="text-[10px] font-mono" style="color:var(--ink-faint);">U${d.unit?.unit_number ?? '?'}</span>
    </button>
  `).join('');

  rail.querySelectorAll('.pulse-chip').forEach(chip => {
    chip.addEventListener('click', () => openDriverDrawer(chip.dataset.driverId));
  });
}

// ----- RENDERIZAR AVISOS DE RUTA -----
async function renderRouteEvents() {
  if (!currentOwner) return;

  const isAdmin = currentOwner.role === 'admin';
  let query = supabase
    .from('route_events')
    .select('*, driver:driver_id ( name, owner_id )')
    .order('created_at', { ascending: false })
    .limit(20);

  if (!isAdmin) {
    query = query.eq('driver.owner_id', currentOwner.id);
  }

  const { data: events, error } = await query;
  if (error) { console.error('Error cargando route_events:', error); return; }

  const list = document.getElementById('routeEventsList');
  if (!events || events.length === 0) {
    list.innerHTML = `<p id="routeEventsEmpty" class="text-sm text-center" style="color:var(--ink-soft);">Todavía no hay avisos de los conductores hoy.</p>`;
    document.getElementById('kpiAvisos').textContent = '0';
    return;
  }

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const todayCount = events.filter(ev => ev.created_at && new Date(ev.created_at) >= startOfDay).length;
  document.getElementById('kpiAvisos').textContent = String(todayCount);

  list.innerHTML = events.map(ev => `
    <div class="flex items-center gap-2.5">
      <span class="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, var(--agave) 16%, var(--surface)); color:var(--agave);"><i data-lucide="flag" class="w-4 h-4"></i></span>
      <div class="min-w-0">
        <p class="font-display font-semibold text-sm truncate">${ev.driver?.name || 'Conductor'} — ${ev.label || 'Aviso'}</p>
        <p class="text-[11px] font-mono truncate" style="color:var(--ink-soft);">${ev.created_at ? new Date(ev.created_at).toLocaleTimeString('es-MX') : '—'}${ev.route ? ' · ' + (ev.route === 'capilla' ? 'Por Capilla' : 'Por Secundaria') : ''}</p>
      </div>
    </div>
  `).join('');
  if (window.lucide) lucide.createIcons();
}

// ----- RENDERIZAR REGISTROS DEL CHECADOR -----
async function renderChecadorEvents() {
  if (!currentOwner) return;

  const isAdmin = currentOwner.role === 'admin';

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  let query = supabase
    .from('checador_events')
    .select('*, driver:driver_id ( name ), unit:unit_id ( unit_number ), checador:checador_id ( name )')
    .gte('created_at', startOfDay.toISOString())
    .order('created_at', { ascending: false })
    .limit(50);

  if (!isAdmin) {
    query = query.eq('owner_id', currentOwner.id);
  }

  const { data: events, error } = await query;
  if (error) { console.error('Error cargando checador_events:', error); return; }

  lastChecadorEvents = events || [];

  const list = document.getElementById('checadorEventsList');
  if (!events || events.length === 0) {
    list.innerHTML = `<p id="checadorEventsEmpty" class="text-sm text-center" style="color:var(--ink-soft);">Todavía no hay registros del checador hoy.</p>`;
    document.getElementById('kpiPunctuality').textContent = '—';
    return;
  }

  const statusInfo = {
    a_tiempo: { label: 'A tiempo', icon: 'check-circle-2', color: 'var(--agave)' },
    retraso: { label: 'Llegó tarde', icon: 'clock', color: 'var(--cempasuchil)' },
    no_se_presento: { label: 'No se presentó', icon: 'alert-triangle', color: 'var(--alerta)' },
  };

  // Puntualidad del día: % de "a_tiempo" sobre el total de registros con estatus conocido
  const known = events.filter(ev => statusInfo[ev.status]);
  const onTime = known.filter(ev => ev.status === 'a_tiempo').length;
  document.getElementById('kpiPunctuality').textContent = known.length
    ? `${Math.round((onTime / known.length) * 100)}%`
    : '—';

  list.innerHTML = events.map((ev) => {
    const info = statusInfo[ev.status] || { label: ev.status || '—', icon: 'circle', color: 'var(--ink-soft)' };
    const routeTxt = ev.route === 'capilla' ? 'Por Capilla' : (ev.route === 'secundaria' ? 'Por Secundaria' : '');
    const time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
    const unitNum = ev.unit?.unit_number != null ? `Unidad ${ev.unit.unit_number}` : 'Unidad —';

    return `
      <div class="flex items-center gap-2.5">
        <span class="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, ${info.color} 18%, var(--surface)); color:${info.color};"><i data-lucide="${info.icon}" class="w-4 h-4"></i></span>
        <div class="min-w-0">
          <p class="font-display font-semibold text-sm truncate">${unitNum} — ${ev.driver?.name || 'Conductor'} — <span style="color:${info.color};">${info.label}</span></p>
          <p class="text-[11px] font-mono truncate" style="color:var(--ink-soft);">${time}${routeTxt ? ' · ' + routeTxt : ''}${ev.ubicacion ? ' · pasó por ' + ev.ubicacion : ''}${ev.checador?.name ? ' · Checador: ' + ev.checador.name : ''}</p>
        </div>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

// ----- RENDERIZAR ALERTAS -----
async function renderAlerts() {
  if (!currentOwner) return;

  const isAdmin = currentOwner.role === 'admin';
  let query = supabase
    .from('panic_alerts')
    .select('*, driver:driver_id ( name )')
    .order('created_at', { ascending: false })
    .limit(20);

  if (!isAdmin) {
    query = query.eq('owner_id', currentOwner.id);
  }

  const { data: alerts, error } = await query;
  if (error) { console.error('Error cargando panic_alerts:', error); return; }

  const list = document.getElementById('alertsList');
  const empty = document.getElementById('alertsEmpty');

  if (!alerts || alerts.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    document.getElementById('alarmBar').classList.remove('show');
    document.getElementById('kpiAlerts').textContent = '0';
    return;
  }
  empty.classList.add('hidden');

  const pendingCount = alerts.filter(a => a.status === 'pendiente').length;
  document.getElementById('kpiAlerts').textContent = String(pendingCount);

  if (pendingCount > 0) {
    document.getElementById('alarmBar').classList.add('show');
  } else {
    document.getElementById('alarmBar').classList.remove('show');
  }

  list.innerHTML = alerts.map(a => {
    const isPending = a.status === 'pendiente';
    const mapsUrl = (a.lat != null && a.lng != null) ? `https://www.google.com/maps?q=${a.lat},${a.lng}` : null;

    return `
      <div class="alert-card p-4 ${isPending ? '' : 'resolved'}">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="font-display font-semibold text-sm flex items-center gap-1.5" style="color:${isPending ? 'var(--alerta)' : 'var(--ink-soft)'};">
              <i data-lucide="${isPending ? 'siren' : 'check-circle-2'}" class="w-4 h-4"></i> ${isPending ? 'Alerta activa' : 'Atendida'} · ${a.driver?.name || 'Conductor'}
            </p>
            <p class="text-xs font-mono mt-0.5" style="color:var(--ink-soft);">${a.created_at ? new Date(a.created_at).toLocaleString('es-MX') : '—'}</p>
          </div>
        </div>
        <div class="flex gap-2 mt-3.5">
          ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-lift text-xs font-semibold px-3.5 py-2 rounded-full flex items-center gap-1.5" style="background:var(--talavera); color:#08131c;"><i data-lucide="map-pin" class="w-3.5 h-3.5"></i> Ver ubicación</a>` : `<span class="text-xs" style="color:var(--ink-soft);">Sin ubicación</span>`}
          ${isPending ? `<button class="resolve-btn btn-lift text-xs font-semibold px-3.5 py-2 rounded-full" style="background:var(--agave); color:#08131c;" data-id="${a.id}">Marcar atendida</button>` : ''}
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.resolve-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const { error } = await supabase
        .from('panic_alerts')
        .update({ status: 'atendida' })
        .eq('id', btn.dataset.id);

      if (error) {
        console.error('Error al marcar alerta como atendida:', error);
        btn.disabled = false;
      } else {
        renderAlerts();
      }
    });
  });
  if (window.lucide) lucide.createIcons();
}

// ----- BOTÓN DE SILENCIAR ALARMA -----
document.getElementById('silenceBtn').addEventListener('click', () => {
  document.getElementById('alarmBar').classList.remove('show');
});

// ----- NAVEGACIÓN LATERAL: marcar el enlace activo según la sección visible -----
const navLinks = Array.from(document.querySelectorAll('aside .nav-item'));
if (navLinks.length) {
  const sectionIds = navLinks.map(a => a.getAttribute('href').slice(1));
  const sections = sectionIds.map(id => document.getElementById(id)).filter(Boolean);

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const id = entry.target.id;
        navLinks.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
      }
    });
  }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });

  sections.forEach(sec => observer.observe(sec));
}
