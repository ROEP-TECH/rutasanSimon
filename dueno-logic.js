import { supabase } from './supabase-config.js';

let currentUser = null;
let currentOwner = null;
let map = null;
let driverMarkers = {};
let locationChannel = null;
let routeChannel = null;
let alertChannel = null;
let checadorEventsChannel = null;
let mapInitialized = false; // <--- ESTO ES NUEVO (Evita que el mapa se duplique)

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
  
  // Inicializar mapa SOLO si no se ha creado antes
  if (!mapInitialized) {
    initMap();
  }
  
  initRealtimeListeners();
  if (window.lucide) lucide.createIcons();
}

// ----- CIERRE DE SESIÓN -----
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  if (locationChannel) supabase.removeChannel(locationChannel);
  if (routeChannel) supabase.removeChannel(routeChannel);
  if (alertChannel) supabase.removeChannel(alertChannel);
  if (checadorEventsChannel) supabase.removeChannel(checadorEventsChannel);
  currentUser = null;
  currentOwner = null;
  mapInitialized = false; // Reiniciamos el flag al cerrar sesión
  mainScreen.classList.add('hidden');
  loginScreen.classList.remove('hidden');
  emailInput.value = '';
  passwordInput.value = '';
});

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

function driverIcon(route) {
  const color = route === 'secundaria' ? '#1E9E5A' : (route === 'capilla' ? '#F5900C' : '#2C9E4A');
  return L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;border-radius:50%;background:${color};border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.5);">🚐</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

// ----- TOAST DE AVISO -----
let toastTimeout = null;
function showToast(message, type = 'normal') {
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  if (!toast || !toastText) return;
  toastText.textContent = message;
  toast.classList.remove('error', 'success');
  if (type === 'error') toast.classList.add('error');
  else if (type === 'success') toast.classList.add('success');
  toast.classList.add('show');
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ----- CENTRAR Y RESALTAR A UN CONDUCTOR EN EL MAPA (al tocarlo en la lista) -----
function focusDriverOnMap(driverId, driverName, isFresh, location) {
  if (!isFresh || !location) {
    showToast(`⚠️ ${driverName} está sin conexión - No hay ubicación disponible`, 'error');
    return;
  }

  if (driverMarkers[driverId]) {
    document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    map.setView(driverMarkers[driverId].getLatLng(), 16, { animate: true });
    driverMarkers[driverId].openPopup();

    const el = driverMarkers[driverId].getElement();
    if (el) {
      el.classList.remove('rss-marker-highlight');
      void el.offsetWidth;
      el.classList.add('rss-marker-highlight');
      setTimeout(() => el.classList.remove('rss-marker-highlight'), 3200);
    }
  }
}

// ----- ESCUCHAR DATOS EN TIEMPO REAL -----
function initRealtimeListeners() {
  // 1. Ubicaciones en vivo
  locationChannel = supabase
    .channel('locations-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'live_locations' }, 
      () => { renderDriversAndMap(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] live_locations:', status, err || '');
    });

  // 2. Eventos de ruta
  routeChannel = supabase
    .channel('route-events-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'route_events' }, 
      () => { renderRouteEvents(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] route_events:', status, err || '');
    });

  // 3. Alertas de pánico
  alertChannel = supabase
    .channel('alerts-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'panic_alerts' }, 
      () => { renderAlerts(); }
    )
    .subscribe((status, err) => {
      console.log('[Realtime] panic_alerts:', status, err || '');
    });

  // 4. Registros del checador (checadas de salida)
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

  // Si NO es admin, filtramos para que solo vea sus propias unidades
  if (!isAdmin) {
    query = query.eq('owner_id', currentOwner.id);
  }

  const { data: drivers, error } = await query;
  
  if (error) {
    console.error("Error al cargar conductores:", error);
    return;
  }

  const list = document.getElementById('driversList');
  list.innerHTML = '';

  let onlineCount = 0;
  let capillaCount = 0;
  let secundariaCount = 0;

  drivers.forEach(d => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at && 
      (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);

    if (fresh) onlineCount++;
    if (d.route === 'capilla') capillaCount++;
    else if (d.route === 'secundaria') secundariaCount++;

    const row = document.createElement('div');
    row.className = 'driver-row py-3 px-3 flex items-center justify-between gap-2';
    if (d.route === 'capilla') row.classList.add('route-capilla');
    else if (d.route === 'secundaria') row.classList.add('route-secundaria');
    const routeLabel = d.route === 'capilla' ? 'Por Capilla' : 
                       d.route === 'secundaria' ? 'Por Secundaria' : 'Sin ramal';
    const routeColor = d.route === 'capilla' ? '#F5900C' : 
                       d.route === 'secundaria' ? '#1E9E5A' : 'var(--ink-soft)';

    let locText = 'Sin conexión';
    if (fresh) {
      const lat = location.lat.toFixed(5);
      const lng = location.lng.toFixed(5);
      locText = `📍 ${lat}, ${lng} · ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
    } else if (location && location.updated_at) {
      locText = `Última vez: ${new Date(location.updated_at).toLocaleTimeString('es-MX')}`;
    }

    row.innerHTML = `
      <div class="flex flex-col gap-3 w-full">
        <!-- Info del conductor -->
        <div class="flex items-start gap-3">
          <div class="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, var(--primary) 16%, var(--paper-2)); color:var(--primary);">
            <i data-lucide="user" class="w-5 h-5"></i>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2 mb-1">
              <p class="font-display font-semibold text-sm" style="color:var(--ink);">${d.name}</p>
              <span class="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full" style="background:${fresh ? 'var(--success-light)' : '#FEE2E2'}; color:${fresh ? 'var(--success)' : '#DC2626'};">
                <span class="status-dot ${fresh ? 'on' : 'off'}"></span> ${fresh ? 'En línea' : 'Sin conexión'}
              </span>
            </div>
            <p class="text-xs font-mono mb-2" style="color:var(--ink-soft);">Unidad ${d.unit?.unit_number || '?'}</p>
            ${fresh && location ? `<p class="text-xs font-mono mb-2" style="color:var(--ink-soft);">${locText}</p>` : ''}
            <span class="text-xs font-semibold px-2 py-1 rounded-lg inline-block" style="background:color-mix(in srgb, ${routeColor} 15%, transparent); color:${routeColor}; border:1px solid ${routeColor}33;">${routeLabel}</span>
          </div>
        </div>
        <!-- Botones -->
        <div class="flex gap-2 pt-2 border-t" style="border-color:var(--border);">
          <button class="view-location-btn btn-lift flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg ${fresh ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}" 
                  style="background:${fresh ? 'var(--primary-light)' : '#F3F4F6'}; color:${fresh ? 'var(--primary)' : 'var(--ink-soft)'};"
                  data-driver-id="${d.id}" 
                  data-driver-name="${d.name}" 
                  data-is-fresh="${fresh}"
                  ${fresh ? '' : 'disabled'}>
            <i data-lucide="${fresh ? 'map-pin' : 'map-x'}" class="w-4 h-4"></i> 
            ${fresh ? 'Ver ubicación' : 'Sin ubicación'}
          </button>
          <button class="center-map-btn btn-lift px-3 py-2 rounded-lg" style="background:var(--paper-2); border:1.5px solid var(--border); color:var(--ink);" aria-label="Centrar mapa en ${d.name}" ${fresh ? '' : 'disabled style="opacity:0.5;"'}>
            <i data-lucide="map" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
    `;
    
    row.classList.add('clickable');
    list.appendChild(row);

    // Botón "Ver ubicación"
    const viewLocBtn = row.querySelector('.view-location-btn');
    if (viewLocBtn && fresh && location) {
      viewLocBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        focusDriverOnMap(d.id, d.name, fresh, location);
      });
    }

    // Botón "Centrar mapa"
    const centerMapBtn = row.querySelector('.center-map-btn');
    if (centerMapBtn && fresh && location) {
      centerMapBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        focusDriverOnMap(d.id, d.name, fresh, location);
      });
    }

    // Evento click en la tarjeta completa
    row.addEventListener('click', () => {
      if (fresh && location) {
        focusDriverOnMap(d.id, d.name, fresh, location);
      } else {
        showToast(`⚠️ ${d.name} está sin conexión`, 'error');
      }
    });
    row.style.cursor = fresh ? 'pointer' : 'default';

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

  document.getElementById('driversOnlineCount').textContent = 
    onlineCount + ' en ruta · ' + capillaCount + ' Capilla · ' + secundariaCount + ' Sec.';

  const statOnlineNumber = document.getElementById('statOnlineNumber');
  const statOnlineSub = document.getElementById('statOnlineSub');
  if (statOnlineNumber) statOnlineNumber.textContent = `${onlineCount}/${drivers.length}`;
  if (statOnlineSub) statOnlineSub.textContent = `${capillaCount} Capilla · ${secundariaCount} Secundaria`;

  const activeMarkers = Object.values(driverMarkers);
  if (activeMarkers.length > 0 && !map._rssCentered) {
    const group = L.featureGroup(activeMarkers);
    map.fitBounds(group.getBounds().pad(0.2));
    map._rssCentered = true;
  }

  if (window.lucide) lucide.createIcons();
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
    return;
  }

  list.innerHTML = events.map(ev => `
    <div class="flex items-center gap-2.5">
      <span class="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, var(--agave) 14%, var(--paper-2)); color:var(--agave);"><i data-lucide="flag" class="w-4 h-4"></i></span>
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

  // Solo lo de hoy (hora local del dispositivo)
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

  const list = document.getElementById('checadorEventsList');
  if (!events || events.length === 0) {
    list.innerHTML = `<p id="checadorEventsEmpty" class="text-sm text-center" style="color:var(--ink-soft);">Todavía no hay registros del checador hoy.</p>`;
    return;
  }

  const statusInfo = {
    a_tiempo: { label: 'A tiempo', icon: 'check-circle-2', color: 'var(--agave)' },
    retraso: { label: 'Llegó tarde', icon: 'clock', color: 'var(--cempasuchil)' },
    no_se_presento: { label: 'No se presentó', icon: 'alert-triangle', color: 'var(--alerta)' },
  };

  list.innerHTML = events.map((ev) => {
    const info = statusInfo[ev.status] || { label: ev.status || '—', icon: 'circle', color: 'var(--ink-soft)' };
    const routeTxt = ev.route === 'capilla' ? 'Por Capilla' : (ev.route === 'secundaria' ? 'Por Secundaria' : '');
    const time = ev.created_at ? new Date(ev.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
    const unitNum = ev.unit?.unit_number != null ? `Unidad ${ev.unit.unit_number}` : 'Unidad —';

    return `
      <div class="flex items-center gap-2.5">
        <span class="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, ${info.color} 16%, var(--paper-2)); color:${info.color};"><i data-lucide="${info.icon}" class="w-4 h-4"></i></span>
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
  const statAlertsCard = document.getElementById('statAlertsCard');
  const statAlertsNumber = document.getElementById('statAlertsNumber');
  const statAlertsSub = document.getElementById('statAlertsSub');

  if (!alerts || alerts.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    document.getElementById('alarmBar').classList.remove('show');
    if (statAlertsCard) {
      statAlertsCard.classList.remove('alert-live');
      statAlertsNumber.textContent = '0';
      statAlertsNumber.style.color = 'var(--agave-dark)';
      statAlertsSub.textContent = 'Todo tranquilo';
    }
    return;
  }
  empty.classList.add('hidden');

  const pendingCount = alerts.filter(a => a.status === 'pendiente').length;
  const anyPending = pendingCount > 0;
  if (anyPending) {
    document.getElementById('alarmBar').classList.add('show');
  } else {
    document.getElementById('alarmBar').classList.remove('show');
  }
  if (statAlertsCard) {
    statAlertsCard.classList.toggle('alert-live', anyPending);
    statAlertsNumber.textContent = String(pendingCount);
    statAlertsNumber.style.color = anyPending ? 'var(--alerta)' : 'var(--agave-dark)';
    statAlertsSub.textContent = anyPending ? 'Necesitan atención' : 'Todo tranquilo';
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
          ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener" class="btn-lift text-xs font-semibold px-3.5 py-2 rounded-full flex items-center gap-1.5" style="background:var(--talavera); color:#fff;"><i data-lucide="map-pin" class="w-3.5 h-3.5"></i> Ver ubicación</a>` : `<span class="text-xs" style="color:var(--ink-soft);">Sin ubicación</span>`}
          ${isPending ? `<button class="resolve-btn btn-lift text-xs font-semibold px-3.5 py-2 rounded-full" style="background:var(--agave); color:#fff;" data-id="${a.id}">Marcar atendida</button>` : ''}
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
        // No esperamos al canal de Realtime: refrescamos de una vez
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

// ----- PESTAÑAS DE ACTIVIDAD (Avisos de ruta / Registros del checador) -----
const tabAvisosBtn = document.getElementById('tabAvisosBtn');
const tabChecadorBtn = document.getElementById('tabChecadorBtn');
const tabAvisosPanel = document.getElementById('tabAvisosPanel');
const tabChecadorPanel = document.getElementById('tabChecadorPanel');

function switchActivityTab(tab) {
  const showAvisos = tab === 'avisos';
  tabAvisosBtn.classList.toggle('active', showAvisos);
  tabChecadorBtn.classList.toggle('active', !showAvisos);
  tabAvisosPanel.classList.toggle('active', showAvisos);
  tabChecadorPanel.classList.toggle('active', !showAvisos);
}

tabAvisosBtn.addEventListener('click', () => switchActivityTab('avisos'));
tabChecadorBtn.addEventListener('click', () => switchActivityTab('checador'));
