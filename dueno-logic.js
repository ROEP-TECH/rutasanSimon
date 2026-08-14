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
    row.className = 'driver-row py-3 flex items-center justify-between gap-2';
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
      <div class="min-w-0 flex items-center gap-2.5">
        <span class="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style="background:color-mix(in srgb, var(--talavera) 14%, var(--paper-2)); color:var(--talavera);"><i data-lucide="user" class="w-4 h-4"></i></span>
        <div class="min-w-0">
          <p class="font-display font-semibold text-sm truncate">${d.name} <span class="text-[10px] font-mono" style="color:var(--ink-soft);">(Unidad ${d.unit?.unit_number || '?'})</span></p>
          <p class="text-[11px] font-mono truncate" style="color:var(--ink-soft);">${locText}</p>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full mt-1 inline-block" style="background:${routeColor}; color:#fff;">${routeLabel}</span>
        </div>
      </div>
      <span class="flex items-center gap-1.5 text-xs font-semibold shrink-0">
        <span class="status-dot ${fresh ? 'on' : 'off'}"></span> ${fresh ? 'En ruta' : 'Sin conexión'}
      </span>
    `;
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

  document.getElementById('driversOnlineCount').textContent = 
    onlineCount + ' en ruta · ' + capillaCount + ' Capilla · ' + secundariaCount + ' Sec.';

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

  if (!alerts || alerts.length === 0) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    document.getElementById('alarmBar').classList.remove('show');
    return;
  }
  empty.classList.add('hidden');

  const anyPending = alerts.some(a => a.status === 'pendiente');
  if (anyPending) {
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
