// ============================================================
//  cambiarVersion.js — Sistema de versiones para todos los paneles
// ============================================================
(function() {
  // === CONFIGURACIÓN DE VERSIÓN ===
  // Cambia esto en cada nueva versión y actualiza el changelog
  const APP_VERSION = '1.0';
  const CHANGELOG = [
    '✨ Nueva funcionalidad de seguimiento en tiempo real.',
    '🐛 Corrección de errores menores en el panel de conductores.',
    '🎨 Mejoras visuales y adaptación a tema claro/oscuro.',
    '🔄 Sistema de actualizaciones unificado para todos los paneles.'
  ];

  // === ELEMENTOS DEL DOM ===
  const versionFooter = document.getElementById('versionFooter');
  const updateOverlay = document.getElementById('updateOverlay');
  const updateVersionDisplay = document.getElementById('updateVersionDisplay');
  const updateChangelog = document.getElementById('updateChangelog');
  const applyBtn = document.getElementById('applyUpdateBtn');
  const skipBtn = document.getElementById('skipUpdateBtn');

  // Mostrar versión en el footer (si existe)
  if (versionFooter) {
    versionFooter.textContent = 'v' + APP_VERSION;
  }

  // === FUNCIONES ===
  function showUpdateModal() {
    if (!updateOverlay) {
      console.warn('No se encontró #updateOverlay en esta página.');
      return;
    }

    // Actualizar número de versión
    if (updateVersionDisplay) {
      updateVersionDisplay.textContent = 'v' + APP_VERSION;
    }

    // Llenar el changelog
    if (updateChangelog) {
      const list = updateChangelog.querySelector('ul');
      if (list) {
        list.innerHTML = '';
        CHANGELOG.forEach(item => {
          const li = document.createElement('li');
          li.innerHTML = `<i data-lucide="check-circle-2" class="w-4 h-4 shrink-0"></i> ${item}`;
          list.appendChild(li);
        });
        // Si Lucide está cargado, refrescar íconos
        if (typeof lucide !== 'undefined') {
          lucide.createIcons();
        }
      }
    }

    updateOverlay.classList.add('show');
  }

  function applyUpdate() {
    localStorage.setItem('app_version', APP_VERSION);
    window.location.reload(true); // Forzar recarga sin caché
  }

  function skipUpdate() {
    if (updateOverlay) {
      updateOverlay.classList.remove('show');
    }
    localStorage.setItem('app_version', APP_VERSION);
  }

  function checkVersion() {
    const savedVersion = localStorage.getItem('app_version');
    // Si no hay versión guardada o es diferente, mostrar el modal
    if (savedVersion !== APP_VERSION) {
      showUpdateModal();
    }
  }

  // === EVENTOS ===
  if (applyBtn) {
    applyBtn.addEventListener('click', applyUpdate);
  }
  if (skipBtn) {
    skipBtn.addEventListener('click', skipUpdate);
  }
  if (updateOverlay) {
    updateOverlay.addEventListener('click', function(e) {
      if (e.target === updateOverlay) {
        skipUpdate();
      }
    });
  }

  // === EJECUTAR AL CARGAR ===
  // Esperamos un poco para que el DOM esté listo y Lucide cargado
  setTimeout(checkVersion, 300);
})();