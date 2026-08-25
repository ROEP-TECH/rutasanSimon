import { supabase } from './supabase-config.js';

let map = null;
let driverMarkers = {}; // driver_id -> L.Marker
let centeredOnce = false;

function routeColor(route) {
  return route === 'secundaria' ? '#2FD98A' : (route === 'capilla' ? '#FFAE33' : '#3FB0F0');
}

function routeLabel(route) {
  return route === 'capilla' ? 'Por Capilla' : (route === 'secundaria' ? 'Por Secundaria' : 'Sin ramal');
}

function driverIcon(route) {
  const color = routeColor(route);
  return L.divIcon({
    className: '',
    html: `<div style="width:34px;height:34px;border-radius:50%;background:${color};border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 2px 10px rgba(0,0,0,.45);">🚐</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: false }).setView([19.272, -98.455], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  L.control.attribution({ prefix: false })
    .addAttribution('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>')
    .addTo(map);
}

async function renderDrivers() {
  const { data: drivers, error } = await supabase
    .from('drivers')
    .select(`
      id, name, route,
      live_location:live_locations ( lat, lng, updated_at )
    `);

  if (error) { console.error('Error cargando conductores para el mapa:', error); return; }

  let onlineCount = 0;
  const seenIds = new Set();
  const activeNames = []; // <--- NUEVO: para guardar nombres de activos

  (drivers || []).forEach((d) => {
    const location = Array.isArray(d.live_location) ? d.live_location[0] : d.live_location;
    const fresh = location && location.updated_at && (new Date() - new Date(location.updated_at) < 2 * 60 * 1000);

    if (fresh && location.lat && location.lng) {
      onlineCount++;
      seenIds.add(d.id);
      activeNames.push(d.name || 'Conductor'); // <--- NUEVO: guardamos el nombre
      
      const latlng = [location.lat, location.lng];
      const popupText = `${d.name || 'Conductor'} · ${routeLabel(d.route)}`;
      if (!driverMarkers[d.id]) {
        driverMarkers[d.id] = L.marker(latlng, { icon: driverIcon(d.route) }).addTo(map).bindPopup(popupText);
      } else {
        driverMarkers[d.id].setLatLng(latlng);
        driverMarkers[d.id].setPopupContent(popupText);
      }
    }
  });

  // --- NUEVO: actualizar la lista de nombres en el DOM ---
  const listContainer = document.getElementById('activeDriversList');
  const noActiveMsg = document.getElementById('noActiveMsg');
  if (listContainer) {
    // Eliminar todos los hijos excepto el mensaje "Ninguno"
    while (listContainer.firstChild) {
      listContainer.removeChild(listContainer.firstChild);
    }
    if (activeNames.length === 0) {
      listContainer.appendChild(noActiveMsg);
      noActiveMsg.style.display = 'inline';
    } else {
      noActiveMsg.style.display = 'none';
      activeNames.forEach(name => {
        const chip = document.createElement('span');
        chip.textContent = name;
        chip.style.cssText = `
          background: var(--surface-2);
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 0.1rem 0.7rem;
          font-size: 12px;
          font-weight: 500;
          color: var(--ink);
          white-space: nowrap;
        `;
        listContainer.appendChild(chip);
      });
    }
  }
  // --- FIN NUEVO ---

  // Quitar del mapa a los conductores que ya no tienen ubicación fresca
  Object.keys(driverMarkers).forEach((id) => {
    if (!seenIds.has(id)) {
      map.removeLayer(driverMarkers[id]);
      delete driverMarkers[id];
    }
  });

  const onlineCountText = document.getElementById('onlineCountText');
  if (onlineCountText) onlineCountText.textContent = `${onlineCount} en ruta`;
  const liveDot = document.getElementById('liveDot');
  if (liveDot) liveDot.classList.toggle('stale', onlineCount === 0);

  const activeMarkers = Object.values(driverMarkers);
  if (activeMarkers.length > 0 && !centeredOnce) {
    const group = L.featureGroup(activeMarkers);
    map.fitBounds(group.getBounds().pad(0.2));
    centeredOnce = true;
  }
}
  });

  // Quitar del mapa a los conductores que ya no tienen ubicación fresca
  Object.keys(driverMarkers).forEach((id) => {
    if (!seenIds.has(id)) {
      map.removeLayer(driverMarkers[id]);
      delete driverMarkers[id];
    }
  });

  const onlineCountText = document.getElementById('onlineCountText');
  if (onlineCountText) onlineCountText.textContent = `${onlineCount} en ruta`;
  const liveDot = document.getElementById('liveDot');
  if (liveDot) liveDot.classList.toggle('stale', onlineCount === 0);

  const activeMarkers = Object.values(driverMarkers);
  if (activeMarkers.length > 0 && !centeredOnce) {
    const group = L.featureGroup(activeMarkers);
    map.fitBounds(group.getBounds().pad(0.2));
    centeredOnce = true;
  }
}

initMap();
renderDrivers();

supabase
  .channel('mapa-vivo-locations-channel')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'live_locations' }, () => renderDrivers())
  .subscribe();

supabase
  .channel('mapa-vivo-drivers-channel')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'drivers' }, () => renderDrivers())
  .subscribe();

setInterval(renderDrivers, 30000);

if (window.lucide) lucide.createIcons();
