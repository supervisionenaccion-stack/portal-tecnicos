// Portal de Tecnicos: cada tecnico entra con su primer nombre + primer apellido
// y una clave de 4 digitos (los ultimos 4 digitos de su RUT), y ve SOLO sus
// propios indicadores (Repetido Reparado + Averias de Infancia).
//
// El RUT se usa UNICAMENTE en este script, en tu computador, para cruzar los
// dos reportes y calcular la clave de 4 digitos. El RUT en si NUNCA se guarda
// en el HTML publicado ni se sube al repositorio -- solo se publica el nombre,
// la clave derivada de 4 digitos, y los indicadores de cada tecnico.
//
// Esto sigue siendo un filtro liviano en el navegador, no seguridad real: al
// ser un sitio estatico, los datos de todos los tecnicos viajan igual al
// navegador; el login solo controla que se MUESTRA. Se acordo asi explicitamente.
//
// Lee los mismos CSV que el proyecto "Supervisor" desde ..\bbdd\ (no duplica datos).

const fs = require('fs');
const path = require('path');

const carpeta = __dirname;
const carpetaBbdd = path.join(carpeta, '..', 'bbdd');
const META_REINCIDENCIA = 0.04;
const META_INFANCIA = 0.025;

function encontrarCsv(prefijoRegex) {
  if (!fs.existsSync(carpetaBbdd)) {
    throw new Error('No existe la carpeta bbdd en ' + path.join(carpeta, '..'));
  }
  const candidatos = fs
    .readdirSync(carpetaBbdd)
    .filter((f) => prefijoRegex.test(f))
    .map((f) => ({ nombre: f, mtime: fs.statSync(path.join(carpetaBbdd, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidatos.length === 0) {
    throw new Error('No se encontro ningun CSV que coincida con ' + prefijoRegex + ' en ' + carpetaBbdd);
  }
  return path.join(carpetaBbdd, candidatos[0].nombre);
}

function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ';') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

function leerCsv(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((l) => {
    const vals = parseCsvLine(l);
    const obj = {};
    headers.forEach((h, i) => (obj[h] = vals[i] !== undefined ? vals[i] : ''));
    return obj;
  });
}

// Solo se usa para calcular la clave de 4 digitos; el resultado (soloDigitos)
// nunca identifica por si solo a una persona.
function ultimos4DigitosRut(r) {
  const limpio = (r || '').toString().trim().toUpperCase().replace(/\./g, '').replace(/-/g, '');
  return limpio.slice(-4);
}

function normalizarTexto(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Nombre chileno tipico: Nombre1 [Nombre2] Apellido1 [Apellido2]
function primerNombreApellido(nombreCompleto) {
  const partes = (nombreCompleto || '').trim().split(/\s+/).filter(Boolean);
  const nombre = partes[0] || '';
  const apellido = partes.length >= 3 ? partes[2] : (partes[1] || '');
  return { nombre, apellido };
}

function loginKey(nombreCompleto) {
  const { nombre, apellido } = primerNombreApellido(nombreCompleto);
  return normalizarTexto(nombre + ' ' + apellido);
}

function mediana(arr) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}
function promedio(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ---------------- Repetido Reparado ----------------
function analizarReincidencias(csvPath) {
  const rows = leerCsv(csvPath);
  const reit = rows.filter((r) => (r['rdy_prd_tiene_reitero_30d'] || '').trim() === '1');
  const reitFolios = new Set(reit.map((r) => r['toa_piv_folio_toa']));

  const porKey = {};
  rows.forEach((r) => {
    const nombre = (r['toa_piv_nombre_tecnico'] || '').trim();
    if (!nombre) return;
    const key = loginKey(nombre);
    if (!porKey[key]) {
      porKey[key] = {
        key, nombre, agencia: (r['toa_piv_agencia'] || '').trim(), clave: ultimos4DigitosRut(r['toa_piv_rut_tecnico']),
        total: 0, reincidencias: 0, dias: [], causas: {},
      };
    }
    porKey[key].total += 1;
    if (reitFolios.has(r['toa_piv_folio_toa'])) {
      porKey[key].reincidencias += 1;
      const dias = Number(r['rdy_prd_q_dias_reitero']);
      if (!Number.isNaN(dias)) porKey[key].dias.push(dias);
      const causa = (r['toa_piv_causa'] || '').trim() || '(sin dato)';
      porKey[key].causas[causa] = (porKey[key].causas[causa] || 0) + 1;
    }
  });

  const byFolio = {};
  rows.forEach((r) => { byFolio[r['toa_piv_folio_toa']] = r; });
  let mismoTotal = {}, mismoSi = {};
  reit.forEach((r) => {
    const nombre = (r['toa_piv_nombre_tecnico'] || '').trim();
    if (!nombre) return;
    const key = loginKey(nombre);
    const r2 = byFolio[r['rdy_prd_reiterado']];
    if (!r2) return;
    mismoTotal[key] = (mismoTotal[key] || 0) + 1;
    if (r2['toa_piv_nombre_tecnico'] === r['toa_piv_nombre_tecnico']) mismoSi[key] = (mismoSi[key] || 0) + 1;
  });
  Object.keys(porKey).forEach((k) => {
    porKey[k].mismoTotal = mismoTotal[k] || 0;
    porKey[k].mismoSi = mismoSi[k] || 0;
  });

  return terminarAnalisis(porKey);
}

// ---------------- Averias de Infancia ----------------
function analizarInfancia(csvPath) {
  const rows = leerCsv(csvPath);
  const instalaciones = rows.filter((r) => ['A', 'T'].includes((r['vpi_tipo_trabajo_producto'] || '').trim()));

  const porKey = {};
  instalaciones.forEach((r) => {
    const nombre = (r['toa_provider_name'] || '').trim();
    if (!nombre) return;
    const key = loginKey(nombre);
    if (!porKey[key]) {
      porKey[key] = {
        key, nombre, agencia: (r['toa_xa_original_agency'] || '').trim(), clave: ultimos4DigitosRut(r['toa_provider_external_id']),
        total: 0, reincidencias: 0, dias: [], causas: {}, mismoTotal: 0, mismoSi: 0,
      };
    }
    porKey[key].total += 1;
    if ((r['infancia'] || '').trim() === '1') {
      porKey[key].reincidencias += 1;
      const dias = Number(r['q_dias_infancia']);
      if (!Number.isNaN(dias)) porKey[key].dias.push(dias);
      const causa = (r['rmdy_causa'] || '').trim() || '(sin dato)';
      porKey[key].causas[causa] = (porKey[key].causas[causa] || 0) + 1;
      porKey[key].mismoTotal += 1;
      if (r['rmdy_nombre_tecnico'] === r['toa_provider_name']) porKey[key].mismoSi += 1;
    }
  });

  return terminarAnalisis(porKey);
}

function terminarAnalisis(porKey) {
  const lista = Object.values(porKey).map((t) => {
    const tasa = t.total ? t.reincidencias / t.total : 0;
    const causaFrecuente = Object.entries(t.causas).sort((a, b) => b[1] - a[1])[0];
    return {
      key: t.key, nombre: t.nombre, agencia: t.agencia, clave: t.clave,
      total: t.total, reincidencias: t.reincidencias, tasa,
      diasPromedio: t.dias.length ? +promedio(t.dias).toFixed(1) : null,
      diasMediana: t.dias.length ? mediana(t.dias) : null,
      causaFrecuente: causaFrecuente ? causaFrecuente[0] : null,
      causaFrecuenteCasos: causaFrecuente ? causaFrecuente[1] : 0,
      mismoTotal: t.mismoTotal, mismoSi: t.mismoSi,
      mismoPct: t.mismoTotal ? +((t.mismoSi / t.mismoTotal) * 100).toFixed(1) : null,
    };
  });

  const elegibles = lista.filter((t) => t.total >= 10).sort((a, b) => a.tasa - b.tasa);
  elegibles.forEach((t, i) => { t.ranking = i + 1; t.rankingTotal = elegibles.length; });

  const promedioEquipo = elegibles.length ? promedio(elegibles.map((t) => t.tasa)) : null;

  const mapa = {};
  lista.forEach((t) => { mapa[t.key] = t; });
  return { mapa, promedioEquipo, totalTecnicos: lista.length };
}

function main() {
  const csvReincidencias = encontrarCsv(/^p23-averias-reiteradas.*COBRA.*\.csv$/i);
  const csvInfancia = encontrarCsv(/^p22-Averias-infancia.*COBRA.*\.csv$/i);
  console.log('CSV Repetido Reparado:', csvReincidencias);
  console.log('CSV Averias de Infancia:', csvInfancia);

  const reincidencias = analizarReincidencias(csvReincidencias);
  const infancia = analizarInfancia(csvInfancia);

  const keysTodos = new Set([...Object.keys(reincidencias.mapa), ...Object.keys(infancia.mapa)]);
  console.log('Tecnicos con datos:', keysTodos.size);

  const tecnicos = {};
  keysTodos.forEach((key) => {
    const r = reincidencias.mapa[key];
    const i = infancia.mapa[key];
    tecnicos[key] = {
      nombre: (r && r.nombre) || (i && i.nombre) || '',
      agencia: (r && r.agencia) || (i && i.agencia) || '',
      clave: (r && r.clave) || (i && i.clave) || '',
      reincidencias: r ? {
        total: r.total, reincidencias: r.reincidencias, tasa: +(r.tasa * 100).toFixed(1),
        ranking: r.ranking || null, rankingTotal: r.rankingTotal || null,
        diasPromedio: r.diasPromedio, causaFrecuente: r.causaFrecuente, causaFrecuenteCasos: r.causaFrecuenteCasos,
        mismoPct: r.mismoPct,
      } : null,
      infancia: i ? {
        total: i.total, reincidencias: i.reincidencias, tasa: +(i.tasa * 100).toFixed(1),
        ranking: i.ranking || null, rankingTotal: i.rankingTotal || null,
        diasPromedio: i.diasPromedio, causaFrecuente: i.causaFrecuente, causaFrecuenteCasos: i.causaFrecuenteCasos,
        mismoPct: i.mismoPct,
      } : null,
    };
  });

  const DATA = {
    generadoEl: new Date().toLocaleString('es-CL'),
    metaReincidencias: +(META_REINCIDENCIA * 100).toFixed(0),
    metaInfancia: +(META_INFANCIA * 100).toFixed(1),
    promedioEquipoReincidencias: reincidencias.promedioEquipo != null ? +(reincidencias.promedioEquipo * 100).toFixed(1) : null,
    promedioEquipoInfancia: infancia.promedioEquipo != null ? +(infancia.promedioEquipo * 100).toFixed(1) : null,
    tecnicos,
  };

  const html = generarHtml(DATA);
  fs.writeFileSync(path.join(carpeta, 'index.html'), html, 'utf8');
  console.log('Portal generado:', path.join(carpeta, 'index.html'));
}

function generarHtml(DATA) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portal Tecnicos · COBRA</title>
<meta name="theme-color" content="#003c71">
<style>
  :root{
    --bg:#eef1f4; --panel:#ffffff; --panel-2:#f5f7f9; --border:#e0e5ea; --text:#22303f; --text-dim:#6b7a8c;
    --cobra-navy:#003c71; --cobra-blue:#0071ce; --celeste:#29a9e0; --celeste-soft:#e8f6fd;
    --promotor:#1fa971; --neutro:#e2962e; --detractor:#e2523e;
  }
  *{box-sizing:border-box;}
  body{ margin:0; font-family:'Segoe UI', Arial, sans-serif; background:var(--bg); color:var(--text); -webkit-font-smoothing:antialiased; }
  header.hero{
    background:linear-gradient(120deg,#ffffff 0%,var(--celeste-soft) 55%,#dcf1fb 100%);
    padding:34px 6vw 40px; position:relative; overflow:hidden; border-bottom:4px solid var(--celeste);
  }
  header.hero::after{
    content:""; position:absolute; right:-100px; top:-100px; width:340px; height:340px; border-radius:50%;
    background:radial-gradient(circle, rgba(41,169,224,0.18), transparent 70%);
  }
  .brand-row{ display:flex; align-items:center; gap:18px; margin-bottom:22px; }
  .brand-row img{ height:46px; }
  .brand-divider{ width:1px; height:34px; background:var(--border); }
  .eyebrow{ text-transform:uppercase; letter-spacing:.14em; font-size:12.5px; color:var(--celeste); font-weight:800; }
  h1{ margin:0 0 6px; font-size:clamp(24px,4vw,34px); font-weight:800; letter-spacing:-0.01em; color:var(--cobra-navy); }
  .subtitle{ color:#3a4a5c; font-size:14.5px; max-width:640px; line-height:1.55; }
  main{ padding:36px 6vw 80px; max-width:900px; margin:0 auto; }
  .panel{ background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:22px 24px; box-shadow:0 4px 14px rgba(20,50,80,.05); }

  #loginBox{ max-width:380px; margin:40px auto 0; }
  #loginBox h2{ margin:0 0 6px; font-size:19px; color:var(--cobra-navy); }
  #loginBox p.desc{ margin:0 0 20px; font-size:13px; color:var(--text-dim); line-height:1.5; }
  .campo{ margin-bottom:14px; }
  .campo label{ display:block; font-size:12px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
  .campo input{ width:100%; padding:11px 13px; border:1px solid var(--border); border-radius:8px; font-size:15px; font-family:inherit; }
  .campo input:focus{ outline:2px solid var(--celeste); border-color:var(--celeste); }
  .campo .ayuda{ font-size:11.5px; color:var(--text-dim); margin-top:4px; }
  #loginBtn{ width:100%; padding:12px; border:none; border-radius:8px; background:var(--cobra-navy); color:#fff; font-size:14.5px; font-weight:700; font-family:inherit; cursor:pointer; margin-top:6px; }
  #loginBtn:hover{ background:var(--cobra-blue); }
  #loginError{ display:none; background:rgba(226,82,62,.1); color:var(--detractor); border-radius:8px; padding:10px 12px; font-size:13px; margin-bottom:14px; }

  #appBox{ display:none; }
  .top-row{ display:flex; justify-content:space-between; align-items:flex-start; gap:14px; flex-wrap:wrap; margin-bottom:6px; }
  #logoutBtn{ background:none; border:1px solid var(--border); color:var(--cobra-navy); padding:8px 14px; border-radius:20px; font-size:12.5px; font-weight:700; font-family:inherit; cursor:pointer; white-space:nowrap; }
  #logoutBtn:hover{ background:var(--panel-2); }
  .kpi-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin:18px 0 28px; }
  .kpi-card{ background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:16px 18px; }
  .kpi-card .label{ font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--text-dim); font-weight:700; margin-bottom:6px; }
  .kpi-card .value{ font-size:26px; font-weight:800; color:var(--cobra-navy); }
  .kpi-card .sub{ font-size:11.5px; color:var(--text-dim); margin-top:4px; }

  .report-section{ margin-bottom:22px; }
  .report-section h2{ font-size:16.5px; color:var(--cobra-navy); margin:0 0 4px; }
  .report-section .meta-desc{ font-size:12.5px; color:var(--text-dim); margin:0 0 14px; }
  .badge{ display:inline-block; padding:3px 11px; border-radius:20px; font-size:12.5px; font-weight:700; }
  .badge.hi{ background:rgba(31,169,113,.12); color:var(--promotor); }
  .badge.mid{ background:rgba(226,150,46,.14); color:var(--neutro); }
  .badge.lo{ background:rgba(226,82,62,.12); color:var(--detractor); }
  .fila-dato{ display:flex; justify-content:space-between; align-items:center; padding:9px 0; border-bottom:1px solid var(--panel-2); font-size:13.5px; }
  .fila-dato:last-child{ border-bottom:none; }
  .fila-dato .k{ color:var(--text-dim); }
  .fila-dato .v{ font-weight:700; color:var(--text); text-align:right; }
  .callout{ border-left:3px solid var(--celeste); background:linear-gradient(90deg, var(--celeste-soft), transparent); padding:12px 16px; border-radius:0 10px 10px 0; font-size:13px; color:#2c3e50; line-height:1.55; margin-top:14px; }
  .sin-datos{ color:var(--text-dim); font-size:13.5px; font-style:italic; }
  footer{ text-align:center; padding:26px; color:var(--text-dim); font-size:11.5px; }
</style>
</head>
<body>

<header class="hero">
  <div class="brand-row">
    <img src="logo-cobra.png" alt="Cobra">
    <div class="brand-divider"></div>
    <div class="eyebrow">Portal de Tecnicos</div>
  </div>
  <h1 id="heroTitle">Mis Indicadores</h1>
  <div class="subtitle" id="heroSubtitle">Ingresa con tu nombre para ver tu tasa de Repetido Reparado y de Averias de Infancia.</div>
</header>

<main>
  <div id="loginBox" class="panel">
    <h2>Iniciar sesion</h2>
    <p class="desc">Usuario: tu primer nombre y primer apellido. Clave: los ultimos 4 digitos de tu RUT.</p>
    <div id="loginError"></div>
    <div class="campo">
      <label for="inputNombre">Nombre y apellido</label>
      <input type="text" id="inputNombre" placeholder="Marcos Aguilar" autocomplete="username">
    </div>
    <div class="campo">
      <label for="inputPass">Clave</label>
      <input type="password" id="inputPass" placeholder="4028" autocomplete="current-password" inputmode="numeric" maxlength="4">
      <div class="ayuda">Son los ultimos 4 digitos de tu RUT.</div>
    </div>
    <button id="loginBtn">Entrar</button>
  </div>

  <div id="appBox">
    <div class="top-row">
      <div>
        <h1 id="saludo" style="font-size:22px;margin-bottom:2px;"></h1>
        <div class="subtitle" id="agenciaTecnico" style="font-size:13px;"></div>
      </div>
      <button id="logoutBtn">Cerrar sesion</button>
    </div>

    <div class="kpi-grid" id="kpiGrid"></div>

    <div class="report-section panel" id="seccionReincidencias"></div>
    <div class="report-section panel" id="seccionInfancia"></div>
  </div>
</main>

<footer id="footerText"></footer>

<script>
const DATA = ${JSON.stringify(DATA)};

function normalizarTexto(s) {
  return (s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ').trim().toUpperCase();
}
function npsClass(tasa, meta) { return tasa <= meta ? 'hi' : (tasa <= meta * 2 ? 'mid' : 'lo'); }
function titleCase(s) { return (s || '').split(' ').map(w => w ? w[0] + w.slice(1).toLowerCase() : w).join(' '); }

document.getElementById('footerText').innerHTML = 'Generado ' + DATA.generadoEl + ' · Portal de Tecnicos COBRA';

function bloqueReporte(titulo, meta, promedioEquipo, datos, formulaTexto) {
  if (!datos) {
    return '<h2>' + titulo + '</h2><p class="sin-datos">No hay registros para ti en este informe en el periodo actual.</p>';
  }
  const tasaTxt = datos.tasa + '%';
  const cls = npsClass(datos.tasa, meta);
  const cumpleTxt = datos.tasa <= meta ? 'Cumple la meta' : 'No cumple la meta';
  let html = '<h2>' + titulo + '</h2>';
  html += '<p class="meta-desc">' + formulaTexto + '</p>';
  html += '<div class="fila-dato"><span class="k">Tu tasa</span><span class="v"><span class="badge ' + cls + '">' + tasaTxt + '</span></span></div>';
  html += '<div class="fila-dato"><span class="k">Meta institucional</span><span class="v">' + meta + '% · ' + cumpleTxt + '</span></div>';
  if (promedioEquipo != null) {
    html += '<div class="fila-dato"><span class="k">Promedio del equipo</span><span class="v">' + promedioEquipo + '%</span></div>';
  }
  if (datos.ranking) {
    html += '<div class="fila-dato"><span class="k">Tu posicion en el ranking</span><span class="v">' + datos.ranking + ' de ' + datos.rankingTotal + '</span></div>';
  }
  html += '<div class="fila-dato"><span class="k">Casos totales evaluados</span><span class="v">' + datos.total + '</span></div>';
  html += '<div class="fila-dato"><span class="k">Casos con problema</span><span class="v">' + datos.reincidencias + '</span></div>';
  if (datos.diasPromedio != null) {
    html += '<div class="fila-dato"><span class="k">Dias promedio hasta el problema</span><span class="v">' + datos.diasPromedio + ' dias</span></div>';
  }
  if (datos.mismoPct != null) {
    html += '<div class="fila-dato"><span class="k">% que tu mismo tuviste que corregir de nuevo</span><span class="v">' + datos.mismoPct + '%</span></div>';
  }
  if (datos.causaFrecuente) {
    html += '<div class="callout"><b>Tu causa mas frecuente:</b> ' + datos.causaFrecuente + ' (' + datos.causaFrecuenteCasos + ' caso' + (datos.causaFrecuenteCasos === 1 ? '' : 's') + ').</div>';
  }
  return html;
}

function mostrarPerfil(t) {
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('appBox').style.display = 'block';
  document.getElementById('saludo').textContent = 'Hola, ' + titleCase(t.nombre);
  document.getElementById('agenciaTecnico').textContent = t.agencia ? ('Agencia: ' + titleCase(t.agencia)) : '';

  let kpiHtml = '';
  if (t.reincidencias) {
    kpiHtml += '<div class="kpi-card"><div class="label">Repetido Reparado</div><div class="value">' + t.reincidencias.tasa + '%</div><div class="sub">Meta ' + DATA.metaReincidencias + '%</div></div>';
  }
  if (t.infancia) {
    kpiHtml += '<div class="kpi-card"><div class="label">Averias de Infancia</div><div class="value">' + t.infancia.tasa + '%</div><div class="sub">Meta ' + DATA.metaInfancia + '%</div></div>';
  }
  document.getElementById('kpiGrid').innerHTML = kpiHtml;

  document.getElementById('seccionReincidencias').innerHTML = bloqueReporte(
    'Repetido Reparado', DATA.metaReincidencias, DATA.promedioEquipoReincidencias, t.reincidencias,
    'Reparaciones tuyas que volvieron a fallar dentro de 30 dias.'
  );
  document.getElementById('seccionInfancia').innerHTML = bloqueReporte(
    'Averias de Infancia', DATA.metaInfancia, DATA.promedioEquipoInfancia, t.infancia,
    'Instalaciones tuyas que generaron una reparacion dentro de su periodo de infancia.'
  );
}

function intentarLogin() {
  const key = normalizarTexto(document.getElementById('inputNombre').value);
  const pass = (document.getElementById('inputPass').value || '').trim();
  const errorBox = document.getElementById('loginError');
  const t = DATA.tecnicos[key];
  if (!t || !key || t.clave !== pass) {
    errorBox.textContent = 'Nombre o clave incorrectos.';
    errorBox.style.display = 'block';
    return;
  }
  errorBox.style.display = 'none';
  sessionStorage.setItem('portalTecnicoKey', key);
  mostrarPerfil(t);
}

document.getElementById('loginBtn').addEventListener('click', intentarLogin);
document.getElementById('inputPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') intentarLogin(); });
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('portalTecnicoKey');
  document.getElementById('appBox').style.display = 'none';
  document.getElementById('loginBox').style.display = 'block';
  document.getElementById('inputNombre').value = '';
  document.getElementById('inputPass').value = '';
});

const keyGuardada = sessionStorage.getItem('portalTecnicoKey');
if (keyGuardada && DATA.tecnicos[keyGuardada]) {
  mostrarPerfil(DATA.tecnicos[keyGuardada]);
}
</script>

</body>
</html>`;
}

main();
