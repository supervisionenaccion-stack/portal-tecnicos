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
const ExcelJS = require('exceljs');

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

const NOMBRES_MES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
function nombreMes(slug) {
  const [y, m] = slug.split('-');
  return NOMBRES_MES[parseInt(m, 10) - 1] + ' ' + y;
}

// El "mes" del informe se toma de partition_date del CSV (la fecha del snapshot
// de datos), no de la fecha del sistema, igual que en Supervisor.
function obtenerSlugDesdeCsv(rows) {
  const pd = (rows[0] && rows[0]['partition_date']) || '';
  if (/^\d{4}-\d{2}/.test(pd)) return pd.slice(0, 7);
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function listarMesesExistentes(carpeta) {
  const re = /^index_(\d{4}-\d{2})\.html$/;
  return fs.readdirSync(carpeta)
    .map((f) => f.match(re))
    .filter(Boolean)
    .map((m) => m[1]);
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

// Clave interna de agrupacion (solo en memoria, nunca se publica): el RUT
// completo normalizado. Se usa para que dos filas de la MISMA persona nunca
// se separen, y para poder detectar cuando dos personas DISTINTAS compartirian
// el mismo login (mismo nombre corto).
function rutInterno(r) {
  return (r || '').toString().trim().toUpperCase().replace(/\./g, '').replace(/-/g, '');
}

// Lee el NPS por tecnico que exporta el informe NPS (repo/proyecto aparte,
// ver actualizar_informe.ps1). Esa BBDD no trae RUT, asi que el cruce con
// cada persona se hace mas abajo por nombre corto (mismo criterio del login).
function cargarNpsTecnicos() {
  const npsPath = path.join(carpetaBbdd, 'nps-tecnicos.json');
  if (!fs.existsSync(npsPath)) {
    console.log('AVISO: no se encontro nps-tecnicos.json en bbdd -- el portal se genera sin datos de NPS.');
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(npsPath, 'utf8'));
  } catch (err) {
    console.log('AVISO: no se pudo leer nps-tecnicos.json (' + err.message + ') -- el portal se genera sin datos de NPS.');
    return null;
  }
}

// Cruza el NPS (agregado por tecnico+zona) con cada persona (identificada por
// RUT) usando el mismo nombre corto del login. Si el tecnico trabajo en mas
// de una zona ese mes (aparece en mas de un grupo tecnico+zona), se combinan
// todas sus encuestas en un solo NPS en vez de elegir una sola zona.
function asignarNps(personas, npsData) {
  if (!npsData || !Array.isArray(npsData.tecnicos)) return;
  const porLogin = {};
  npsData.tecnicos.forEach((t) => {
    const key = loginKey(t.tecnico);
    if (!porLogin[key]) porLogin[key] = [];
    porLogin[key].push(t);
  });

  personas.forEach((p) => {
    const candidatos = porLogin[loginKey(p.nombre)];
    if (!candidatos || candidatos.length === 0) { p.nps = null; return; }
    const total = candidatos.reduce((a, c) => a + c.total, 0);
    const promotores = candidatos.reduce((a, c) => a + c.P, 0);
    const neutros = candidatos.reduce((a, c) => a + c.N, 0);
    const detractores = candidatos.reduce((a, c) => a + c.D, 0);
    const zonas = [...new Set(candidatos.map((c) => c.zona))];
    p.nps = {
      nps: total ? +(((promotores - detractores) / total) * 100).toFixed(1) : null,
      total, promotores, neutros, detractores,
      zona: zonas.join(' y '),
    };
  });
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
  // Mismos criterios que Supervisor: agencia SUR, tecnologia FO, empresa
  // COBRA, sin tecnicos "PTA", y sin ciertas claves de cierre no validas
  // (derivadas de rdy_prd_cat_nivel_2_sol).
  const AGENCIAS_VALIDAS = ['COYHAIQUE', 'PUNTA ARENAS'];
  const CLAVES_CIERRE_EXCLUIDAS = ['913', 'F20', 'F23', '561', 'A12', 'B01', 'B36', 'I50'];
  function tecnologiaFila(r) {
    return (r['toa_piv_tecnologia'] === 'FO' || r['toa_piv_descripcion'] === 'FO') ? 'FO' : r['toa_piv_tecnologia'];
  }
  function claveCierreFila(r) {
    return (r['rdy_prd_cat_nivel_2_sol'] || '').split('_')[0];
  }
  const rows = leerCsv(csvPath).filter((r) =>
    AGENCIAS_VALIDAS.includes((r['toa_piv_agencia'] || '').trim()) &&
    !CLAVES_CIERRE_EXCLUIDAS.includes(claveCierreFila(r)) &&
    !(r['toa_piv_nombre_tecnico'] || '').includes('PTA') &&
    tecnologiaFila(r) === 'FO' &&
    (r['toa_piv_empresa'] || '').trim() === 'COBRA'
  );
  const reit = rows.filter((r) => (r['rdy_prd_tiene_reitero_30d'] || '').trim() === '1');
  const reitFolios = new Set(reit.map((r) => r['toa_piv_folio_toa']));

  const porRut = {};
  rows.forEach((r) => {
    const nombre = (r['toa_piv_nombre_tecnico'] || '').trim();
    const rut = rutInterno(r['toa_piv_rut_tecnico']);
    if (!nombre || !rut) return;
    if (!porRut[rut]) {
      porRut[rut] = {
        rut, nombre, agencia: (r['toa_piv_agencia'] || '').trim(), clave: ultimos4DigitosRut(r['toa_piv_rut_tecnico']),
        total: 0, reincidencias: 0, dias: [], causas: {},
      };
    }
    porRut[rut].total += 1;
    if (reitFolios.has(r['toa_piv_folio_toa'])) {
      porRut[rut].reincidencias += 1;
      const dias = Number(r['rdy_prd_q_dias_reitero']);
      if (!Number.isNaN(dias)) porRut[rut].dias.push(dias);
      const causa = (r['toa_piv_causa'] || '').trim() || '(sin dato)';
      porRut[rut].causas[causa] = (porRut[rut].causas[causa] || 0) + 1;
    }
  });

  const byFolio = {};
  rows.forEach((r) => { byFolio[r['toa_piv_folio_toa']] = r; });
  let mismoTotal = {}, mismoSi = {};
  reit.forEach((r) => {
    const rut = rutInterno(r['toa_piv_rut_tecnico']);
    if (!rut || !porRut[rut]) return;
    const r2 = byFolio[r['rdy_prd_reiterado']];
    if (!r2) return;
    mismoTotal[rut] = (mismoTotal[rut] || 0) + 1;
    if (r2['toa_piv_nombre_tecnico'] === r['toa_piv_nombre_tecnico']) mismoSi[rut] = (mismoSi[rut] || 0) + 1;
  });
  Object.keys(porRut).forEach((k) => {
    porRut[k].mismoTotal = mismoTotal[k] || 0;
    porRut[k].mismoSi = mismoSi[k] || 0;
  });

  return terminarAnalisis(porRut);
}

// ---------------- Averias de Infancia ----------------
function analizarInfancia(csvPath) {
  // Mismos criterios que Supervisor: solo agencias de la zona SUR, solo filas
  // de la empresa COBRA, y se descartan tecnicos "PTA" (placeholders que han
  // aparecido sueltos en el archivo origen).
  const AGENCIAS_VALIDAS = ['COYHAIQUE', 'PUNTA ARENAS'];
  const rows = leerCsv(csvPath).filter((r) =>
    AGENCIAS_VALIDAS.includes((r['toa_xa_original_agency'] || '').trim()) &&
    (r['toa_xr_company_name'] || '').trim().toUpperCase() === 'COBRA' &&
    !(r['toa_provider_name'] || '').includes('PTA')
  );
  // Instalaciones (Alta), traslados (T) y tipo B; se excluyen ademas ciertas
  // claves de cierre de la reparacion de infancia que no representan un caso valido.
  const CLAVES_CIERRE_EXCLUIDAS = ['F20', 'F23', '913', '561', 'A12', 'B01', 'B36', 'I50'];
  const instalaciones = rows.filter((r) =>
    ['A', 'T', 'B'].includes((r['vpi_tipo_trabajo_producto'] || '').trim()) &&
    !CLAVES_CIERRE_EXCLUIDAS.includes((r['rmdy_clave_cierre'] || '').trim())
  );

  const porRut = {};
  instalaciones.forEach((r) => {
    const nombre = (r['toa_provider_name'] || '').trim();
    const rut = rutInterno(r['toa_provider_external_id']);
    if (!nombre || !rut) return;
    if (!porRut[rut]) {
      porRut[rut] = {
        rut, nombre, agencia: (r['toa_xa_original_agency'] || '').trim(), clave: ultimos4DigitosRut(r['toa_provider_external_id']),
        total: 0, reincidencias: 0, dias: [], causas: {}, mismoTotal: 0, mismoSi: 0,
      };
    }
    porRut[rut].total += 1;
    if ((r['infancia'] || '').trim() === '1') {
      porRut[rut].reincidencias += 1;
      const dias = Number(r['q_dias_infancia']);
      if (!Number.isNaN(dias)) porRut[rut].dias.push(dias);
      const causa = (r['rmdy_causa'] || '').trim() || '(sin dato)';
      porRut[rut].causas[causa] = (porRut[rut].causas[causa] || 0) + 1;
      porRut[rut].mismoTotal += 1;
      if (r['rmdy_nombre_tecnico'] === r['toa_provider_name']) porRut[rut].mismoSi += 1;
    }
  });

  return terminarAnalisis(porRut);
}

function terminarAnalisis(porRut) {
  const lista = Object.values(porRut).map((t) => {
    const tasa = t.total ? t.reincidencias / t.total : 0;
    const causaFrecuente = Object.entries(t.causas).sort((a, b) => b[1] - a[1])[0];
    return {
      rut: t.rut, nombre: t.nombre, agencia: t.agencia, clave: t.clave,
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
  lista.forEach((t) => { mapa[t.rut] = t; });
  return { mapa, promedioEquipo, totalTecnicos: lista.length };
}

async function main() {
  const csvReincidencias = encontrarCsv(/^p23-averias-reiteradas.*COBRA.*\.csv$/i);
  const csvInfancia = encontrarCsv(/^p22-Averias-infancia.*COBRA.*\.csv$/i);
  console.log('CSV Repetido Reparado:', csvReincidencias);
  console.log('CSV Averias de Infancia:', csvInfancia);

  const periodoSlug = obtenerSlugDesdeCsv(leerCsv(csvReincidencias));
  const slugsExistentes = new Set(listarMesesExistentes(carpeta));
  slugsExistentes.add(periodoSlug);
  const archivos = [...slugsExistentes].sort().reverse().map((s) => ({
    slug: s,
    label: nombreMes(s),
    url: s === periodoSlug ? 'index.html' : `index_${s}.html`,
  }));

  const reincidencias = analizarReincidencias(csvReincidencias);
  const infancia = analizarInfancia(csvInfancia);

  // Fusion por RUT interno (nunca por nombre): garantiza que dos personas
  // distintas jamas se mezclen, aunque tengan el mismo nombre corto.
  const rutsTodos = new Set([...Object.keys(reincidencias.mapa), ...Object.keys(infancia.mapa)]);
  console.log('Tecnicos con datos:', rutsTodos.size);

  const personas = [...rutsTodos].map((rut) => {
    const r = reincidencias.mapa[rut];
    const i = infancia.mapa[rut];
    return {
      rut,
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

  const npsData = cargarNpsTecnicos();
  asignarNps(personas, npsData);

  // Asignar el login (nombre corto) a cada persona. Si dos personas DISTINTAS
  // comparten el mismo nombre corto, se le agrega " 2", " 3"... a partir de la
  // segunda (ordenadas por nombre completo, para que el resultado sea estable
  // entre corridas) y se alerta bien visible para que se le avise al tecnico.
  const grupos = {};
  personas.forEach((p) => {
    const base = loginKey(p.nombre);
    if (!grupos[base]) grupos[base] = [];
    grupos[base].push(p);
  });

  // IMPORTANTE: "rut" solo se usa internamente para fusionar/desambiguar.
  // Se descarta aqui y nunca se incluye en el objeto publicado.
  function sinRut(p) {
    const { rut, ...resto } = p;
    return resto;
  }

  const tecnicos = {};
  const colisiones = [];
  Object.entries(grupos).forEach(([base, grupo]) => {
    if (grupo.length === 1) {
      tecnicos[base] = sinRut(grupo[0]);
      return;
    }
    colisiones.push(base);
    grupo
      .sort((a, b) => a.nombre.localeCompare(b.nombre))
      .forEach((p, i) => {
        const keyFinal = i === 0 ? base : base + ' ' + (i + 1);
        tecnicos[keyFinal] = sinRut(p);
        colisiones.push('   -> ' + p.nombre + '  (login: "' + keyFinal + '")');
      });
  });

  if (colisiones.length) {
    console.log('');
    console.log('==============================================================');
    console.log('  ALERTA: nombres de login repetidos (mismo primer nombre +');
    console.log('  primer apellido) entre tecnicos DISTINTOS. Se les asigno un');
    console.log('  numero para diferenciarlos. Avisales su login exacto:');
    console.log('==============================================================');
    colisiones.forEach((linea) => console.log(linea));
    console.log('==============================================================');
    console.log('');
  }

  const DATA = {
    generadoEl: new Date().toLocaleString('es-CL'),
    periodoSlug,
    archivos,
    metaReincidencias: +(META_REINCIDENCIA * 100).toFixed(0),
    metaInfancia: +(META_INFANCIA * 100).toFixed(1),
    promedioEquipoReincidencias: reincidencias.promedioEquipo != null ? +(reincidencias.promedioEquipo * 100).toFixed(1) : null,
    promedioEquipoInfancia: infancia.promedioEquipo != null ? +(infancia.promedioEquipo * 100).toFixed(1) : null,
    metaNps: npsData ? npsData.meta : null,
    periodoNps: npsData ? npsData.periodo : null,
    tecnicos,
  };

  const html = generarHtml(DATA);
  fs.writeFileSync(path.join(carpeta, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(carpeta, `index_${periodoSlug}.html`), html, 'utf8');
  console.log('Portal generado:', path.join(carpeta, 'index.html'), 'y', `index_${periodoSlug}.html`);

  fs.writeFileSync(
    path.join(carpeta, 'meses.json'),
    JSON.stringify(archivos),
    'utf8'
  );
  console.log('meses.json generado:', archivos.length, 'mes(es) disponibles');

  await generarExcelCredenciales(tecnicos);
}

// Excel SOLO local (esta en .gitignore, nunca se sube a GitHub) con el
// listado de usuario/clave de cada tecnico, para que se los puedas repartir.
async function generarExcelCredenciales(tecnicos) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Portal de Tecnicos';
  wb.created = new Date();

  const ws = wb.addWorksheet('Credenciales', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Nombre completo', key: 'nombre', width: 34 },
    { header: 'Agencia', key: 'agencia', width: 16 },
    { header: 'Usuario (nombre a ingresar)', key: 'usuario', width: 28 },
    { header: 'Clave', key: 'clave', width: 12 },
  ];

  Object.entries(tecnicos)
    .sort((a, b) => a[1].nombre.localeCompare(b[1].nombre))
    .forEach(([usuario, t]) => {
      ws.addRow({ nombre: t.nombre, agencia: t.agencia, usuario, clave: t.clave });
    });

  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell) => {
    cell.font = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF003C71' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  headerRow.height = 26;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => { cell.font = { name: 'Arial', size: 10.5 }; });
    row.getCell('clave').font = { name: 'Arial', size: 10.5, bold: true };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Object.keys(tecnicos).length + 1, column: 4 } };

  const notas = wb.addWorksheet('Notas');
  notas.columns = [{ width: 100 }];
  [
    'CREDENCIALES DEL PORTAL DE TECNICOS',
    '',
    'Este archivo es SOLO PARA USO LOCAL. No se sube al repositorio (esta en .gitignore) ni se publica en ningun lado.',
    '',
    'Cada tecnico entra en https://supervisionenaccion-stack.github.io/portal-tecnicos/ con el "Usuario" y la "Clave" de su fila.',
    'El usuario es su primer nombre + primer apellido (tal como aparece en la columna "Usuario"). No distingue mayusculas/minusculas.',
    'La clave son los ultimos 4 digitos de su RUT (con el digito verificador, sin guion). Tampoco distingue mayusculas/minusculas si termina en K.',
    '',
    'Se regenera cada vez que corres Generar_Reporte_Reincidencias.bat -- vuelve a abrir este archivo despues de actualizar para ver los datos del dia.',
  ].forEach((t, i) => {
    const row = notas.addRow([t]);
    row.getCell(1).font = i === 0 ? { name: 'Arial', bold: true, size: 12 } : { name: 'Arial', size: 10 };
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
  });

  const outPath = path.join(carpeta, 'Credenciales_Tecnicos_NO_SUBIR.xlsx');
  await wb.xlsx.writeFile(outPath);
  console.log('Excel de credenciales generado (local, no se sube):', outPath);
}

function generarHtml(DATA) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portal Tecnicos · COBRA</title>
<meta name="theme-color" content="#003c71">
<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Portal Tecnicos">
<style>
  :root{
    --bg:#eef1f4; --panel:#ffffff; --panel-2:#f5f7f9; --border:#e0e5ea; --text:#22303f; --text-dim:#6b7a8c;
    --cobra-navy:#003c71; --cobra-blue:#0071ce; --celeste:#29a9e0; --celeste-soft:#e8f6fd;
    --promotor:#1fa971; --promotor-bg:#e2f6ee; --neutro:#e2962e; --neutro-bg:#fdf1e2; --detractor:#e2523e; --detractor-bg:#fce4e0;
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
  .archive-row{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:16px; }
  .archive-row .archive-label{ font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:700; color:var(--text-dim); margin-right:2px; }
  .archive-pill{ display:inline-block; font-size:12px; font-weight:700; padding:4px 12px; border-radius:20px; text-decoration:none; border:1px solid var(--border); color:var(--cobra-navy); background:#fff; transition:background .15s ease; }
  .archive-pill:hover{ background:var(--celeste-soft); }
  .archive-pill.current{ background:var(--cobra-navy); color:#fff; border-color:var(--cobra-navy); cursor:default; }
  main{ padding:36px 6vw 80px; max-width:760px; margin:0 auto; }
  .panel{ background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:22px 24px; box-shadow:0 4px 14px rgba(20,50,80,.05); }

  #loginBox{ max-width:400px; margin:40px auto 0; text-align:center; }
  #loginBox .icono-login{ font-size:38px; margin-bottom:6px; }
  #loginBox h2{ margin:0 0 8px; font-size:20px; color:var(--cobra-navy); }
  #loginBox p.desc{ margin:0 0 22px; font-size:13.5px; color:var(--text-dim); line-height:1.6; }
  .campo{ margin-bottom:14px; text-align:left; }
  .campo label{ display:block; font-size:12px; font-weight:700; color:var(--text-dim); text-transform:uppercase; letter-spacing:.04em; margin-bottom:6px; }
  .campo input{ width:100%; padding:12px 13px; border:1px solid var(--border); border-radius:8px; font-size:16px; font-family:inherit; }
  .campo input:focus{ outline:2px solid var(--celeste); border-color:var(--celeste); }
  .campo .ayuda{ font-size:11.5px; color:var(--text-dim); margin-top:4px; text-align:left; }
  #loginBtn{ width:100%; padding:13px; border:none; border-radius:8px; background:var(--cobra-navy); color:#fff; font-size:15px; font-weight:700; font-family:inherit; cursor:pointer; margin-top:8px; }
  #loginBtn:hover{ background:var(--cobra-blue); }
  #loginError{ display:none; background:var(--detractor-bg); color:var(--detractor); border-radius:8px; padding:10px 12px; font-size:13px; margin-bottom:14px; text-align:left; }

  #appBox{ display:none; }
  .top-row{ display:flex; justify-content:space-between; align-items:flex-start; gap:14px; flex-wrap:wrap; margin-bottom:4px; }
  #logoutBtn{ background:none; border:1px solid var(--border); color:var(--cobra-navy); padding:8px 14px; border-radius:20px; font-size:12.5px; font-weight:700; font-family:inherit; cursor:pointer; white-space:nowrap; }
  #logoutBtn:hover{ background:var(--panel-2); }
  .intro-personal{ font-size:14px; color:var(--text-dim); line-height:1.6; margin:4px 0 22px; }

  .resumen-general{ display:flex; align-items:center; gap:16px; padding:20px 22px; border-radius:14px; margin-bottom:24px; border:1px solid var(--border); }
  .resumen-general.ok{ background:var(--promotor-bg); border-color:rgba(31,169,113,.3); }
  .resumen-general.warn{ background:var(--neutro-bg); border-color:rgba(226,150,46,.3); }
  .resumen-general.bad{ background:var(--detractor-bg); border-color:rgba(226,82,62,.3); }
  .resumen-general .emoji{ font-size:34px; flex-shrink:0; }
  .resumen-general .texto b{ display:block; font-size:16px; margin-bottom:2px; }
  .resumen-general.ok .texto b{ color:var(--promotor); }
  .resumen-general.warn .texto b{ color:var(--neutro); }
  .resumen-general.bad .texto b{ color:var(--detractor); }
  .resumen-general .texto span{ font-size:13px; color:var(--text-dim); }

  .report-card{ margin-bottom:22px; }
  .report-card .cabecera{ display:flex; align-items:center; gap:10px; margin-bottom:4px; }
  .report-card .cabecera .icono{ font-size:22px; }
  .report-card .cabecera h2{ font-size:17px; color:var(--cobra-navy); margin:0; }
  .report-card .explica{ font-size:13px; color:var(--text-dim); margin:0 0 16px; line-height:1.55; }
  .estado-pill{ display:inline-flex; align-items:center; gap:6px; padding:5px 13px; border-radius:20px; font-size:13px; font-weight:700; margin-bottom:14px; }
  .estado-pill.ok{ background:var(--promotor-bg); color:var(--promotor); }
  .estado-pill.warn{ background:var(--neutro-bg); color:var(--neutro); }
  .estado-pill.bad{ background:var(--detractor-bg); color:var(--detractor); }

  .barra-wrap{ margin:10px 0 16px; }
  .barra-track{ position:relative; height:22px; background:var(--panel-2); border-radius:11px; overflow:visible; }
  .barra-fill{ position:absolute; left:0; top:0; bottom:0; border-radius:11px; display:flex; align-items:center; justify-content:flex-end; padding-right:10px; }
  .barra-fill span{ font-size:11.5px; font-weight:800; color:#fff; white-space:nowrap; }
  .barra-fill.ok{ background:var(--promotor); }
  .barra-fill.warn{ background:var(--neutro); }
  .barra-fill.bad{ background:var(--detractor); }
  .barra-meta{ position:absolute; top:-4px; bottom:-4px; width:2px; background:#334; }
  .barra-meta-label{ position:absolute; top:-18px; font-size:10.5px; color:var(--text-dim); transform:translateX(-50%); white-space:nowrap; }

  .frase-clave{ font-size:14.5px; line-height:1.6; margin:0 0 14px; }
  .frase-clave b{ color:var(--cobra-navy); }

  .detalle-toggle{ font-size:12.5px; color:var(--celeste); font-weight:700; cursor:pointer; user-select:none; display:inline-flex; align-items:center; gap:4px; margin-top:6px; }
  .detalle-body{ display:none; margin-top:12px; padding-top:12px; border-top:1px solid var(--panel-2); }
  .detalle-body.abierto{ display:block; }
  .fila-dato{ display:flex; justify-content:space-between; align-items:center; padding:7px 0; font-size:13px; }
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
  <div class="subtitle" id="heroSubtitle">Aca puedes ver, de forma simple, como te fue este mes y en que puedes enfocarte para mejorar.</div>
  <div class="archive-row" id="archiveRow"></div>
</header>

<main>
  <div id="loginBox" class="panel">
    <div class="icono-login">👋</div>
    <h2>Bienvenido</h2>
    <p class="desc">Ingresa con tu nombre y tu clave para ver tu reporte personal. Nadie mas puede ver tu informacion.</p>
    <div id="loginError"></div>
    <div class="campo">
      <label for="inputNombre">Nombre y apellido</label>
      <input type="text" id="inputNombre" placeholder="Ej: Marcos Aguilar" autocomplete="username">
    </div>
    <div class="campo">
      <label for="inputPass">Clave (4 numeros)</label>
      <input type="password" id="inputPass" placeholder="••••" autocomplete="current-password" inputmode="numeric" maxlength="4">
      <div class="ayuda">Son los ultimos 4 digitos de tu RUT, incluido el digito verificador, sin guion.</div>
    </div>
    <button id="loginBtn">Ver mi reporte</button>
  </div>

  <div id="appBox">
    <div class="top-row">
      <div>
        <h1 id="saludo" style="font-size:22px;margin-bottom:2px;"></h1>
        <div class="subtitle" id="agenciaTecnico" style="font-size:13px;"></div>
      </div>
      <button id="logoutBtn">Cerrar sesion</button>
    </div>
    <p class="intro-personal">Este es tu reporte personal de calidad. Te mostramos como te fue este mes con tus reparaciones, y en que puedes enfocarte para mejorar.</p>

    <div id="resumenGeneral"></div>

    <div class="report-card panel" id="seccionReincidencias"></div>
    <div class="report-card panel" id="seccionInfancia"></div>
    <div class="report-card panel" id="seccionNps"></div>
  </div>
</main>

<footer id="footerText"></footer>

<script>
const DATA = ${JSON.stringify(DATA)};

function normalizarTexto(s) {
  return (s || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/\\s+/g, ' ').trim().toUpperCase();
}
function titleCase(s) { return (s || '').split(' ').map(w => w ? w[0] + w.slice(1).toLowerCase() : w).join(' '); }

document.getElementById('footerText').innerHTML = 'Generado ' + DATA.generadoEl + ' · Portal de Tecnicos COBRA';

// ---- Historial de meses ----
function renderArchiveRow(lista) {
  if (!lista || lista.length < 2) return;
  const pills = lista.map(a =>
    a.slug === DATA.periodoSlug
      ? '<span class="archive-pill current">' + a.label + '</span>'
      : '<a class="archive-pill" href="' + a.url + '">' + a.label + '</a>'
  ).join('');
  document.getElementById('archiveRow').innerHTML = '<span class="archive-label">📁 Meses disponibles:</span>' + pills;
}
renderArchiveRow(DATA.archivos);
fetch('meses.json', { cache: 'no-store' })
  .then(r => r.ok ? r.json() : null)
  .then(lista => { if (lista) renderArchiveRow(lista); })
  .catch(() => {});

function estado(tasa, meta) {
  if (tasa <= meta) return { emoji: '✅', texto: 'Cumples la meta', clase: 'ok' };
  if (tasa <= meta * 1.5) return { emoji: '⚠️', texto: 'Fuera de la meta', clase: 'warn' };
  return { emoji: '🔴', texto: 'Muy fuera de la meta', clase: 'bad' };
}

// El NPS va al reves que las tasas de arriba: mientras mas alto, mejor.
function estadoNps(nps, meta) {
  if (nps >= meta) return { emoji: '✅', texto: 'Cumples la meta', clase: 'ok' };
  if (nps >= meta - 15) return { emoji: '⚠️', texto: 'Fuera de la meta', clase: 'warn' };
  return { emoji: '🔴', texto: 'Muy fuera de la meta', clase: 'bad' };
}

function barraNps(nps, meta, cls) {
  const posicion = (v) => ((Math.max(-100, Math.min(100, v)) + 100) / 200) * 100;
  const anchoNps = posicion(nps);
  const posMeta = posicion(meta);
  return '<div class="barra-wrap">'
    + '<div class="barra-track">'
    + '<div class="barra-fill ' + cls + '" style="width:' + anchoNps.toFixed(1) + '%"><span>' + nps + '%</span></div>'
    + '<div class="barra-meta" style="left:' + posMeta.toFixed(1) + '%"></div>'
    + '<div class="barra-meta-label" style="left:' + posMeta.toFixed(1) + '%">Meta ' + meta + '%</div>'
    + '</div></div>';
}

function bloqueNps(t) {
  const icono = '⭐', titulo = 'Satisfaccion del cliente (NPS)';
  const periodoTexto = DATA.periodoNps ? (' Datos de ' + DATA.periodoNps + '.') : '';
  const explicacion = 'Mide que tan satisfechos quedan tus clientes despues de tu visita, segun encuestas propias.' + periodoTexto + ' Mientras mas alto, mejor.';
  if (DATA.metaNps == null || !t.nps) {
    return '<div class="cabecera"><span class="icono">' + icono + '</span><h2>' + titulo + '</h2></div>'
      + '<p class="explica">' + explicacion + '</p>'
      + '<p class="sin-datos">No hay suficientes encuestas respondidas para calcular tu NPS este periodo (se necesitan al menos 5).</p>';
  }
  const datos = t.nps;
  const meta = DATA.metaNps;
  const est = estadoNps(datos.nps, meta);
  const cumpleFrase = datos.nps >= meta
    ? 'Tu NPS (<b>' + datos.nps + '%</b>) cumple la meta (' + meta + '%).'
    : 'Tu NPS (<b>' + datos.nps + '%</b>) esta <b>bajo la meta</b> (' + meta + '%) — te faltan ' + (meta - datos.nps).toFixed(1) + ' puntos para cumplirla.';

  contadorDetalle++;
  const idDetalle = 'detalle' + contadorDetalle;

  let html = '<div class="cabecera"><span class="icono">' + icono + '</span><h2>' + titulo + '</h2></div>';
  html += '<p class="explica">' + explicacion + '</p>';
  html += '<div class="estado-pill ' + est.clase + '">' + est.emoji + ' ' + est.texto + '</div>';
  html += barraNps(datos.nps, meta, est.clase);
  html += '<p class="frase-clave">' + cumpleFrase + '</p>';
  html += '<p class="frase-clave">Calculado sobre <b>' + datos.total + '</b> encuestas respondidas' + (datos.zona ? ' en ' + datos.zona : '') + '.</p>';
  html += '<div class="detalle-toggle" onclick="toggleDetalle(\\'' + idDetalle + '\\')">Ver el detalle en numeros <span id="' + idDetalle + 'Flecha">▾</span></div>';
  html += '<div class="detalle-body" id="' + idDetalle + '">';
  html += '<div class="fila-dato"><span class="k">Encuestas respondidas</span><span class="v">' + datos.total + '</span></div>';
  html += '<div class="fila-dato"><span class="k">Promotores</span><span class="v">' + datos.promotores + '</span></div>';
  html += '<div class="fila-dato"><span class="k">Neutros</span><span class="v">' + datos.neutros + '</span></div>';
  html += '<div class="fila-dato"><span class="k">Detractores</span><span class="v">' + datos.detractores + '</span></div>';
  html += '</div>';
  return html;
}

function barraTasa(tasa, meta, cls) {
  const escala = Math.max(tasa, meta * 2, 5) * 1.15;
  const anchoTasa = Math.min(100, (tasa / escala) * 100);
  const posMeta = Math.min(100, (meta / escala) * 100);
  return '<div class="barra-wrap">'
    + '<div class="barra-track">'
    + '<div class="barra-fill ' + cls + '" style="width:' + anchoTasa.toFixed(1) + '%"><span>' + tasa + '%</span></div>'
    + '<div class="barra-meta" style="left:' + posMeta.toFixed(1) + '%"></div>'
    + '<div class="barra-meta-label" style="left:' + posMeta.toFixed(1) + '%">Meta ' + meta + '%</div>'
    + '</div></div>';
}

let contadorDetalle = 0;

function bloqueReporte(opts) {
  const { icono, titulo, explicacion, meta, promedioEquipo, datos, fraseFormula } = opts;
  if (!datos) {
    return '<div class="cabecera"><span class="icono">' + icono + '</span><h2>' + titulo + '</h2></div>'
      + '<p class="sin-datos">No hay registros para ti en este informe en el periodo actual.</p>';
  }
  const est = estado(datos.tasa, meta);
  const cumpleFrase = datos.tasa <= meta
    ? 'Tu tasa (<b>' + datos.tasa + '%</b>) esta dentro de la meta (no superar el ' + meta + '%).'
    : 'Tu tasa (<b>' + datos.tasa + '%</b>) esta <b>sobre la meta</b> (no debe superar el ' + meta + '%) — te faltan '
      + (datos.tasa - meta).toFixed(1) + ' puntos para cumplirla.';
  let compEquipo = '';
  if (promedioEquipo != null) {
    if (datos.tasa < promedioEquipo) {
      compEquipo = datos.tasa <= meta
        ? ' Ademas, es mejor que el promedio del equipo (' + promedioEquipo + '%).'
        : ' Aun asi, es mejor que el promedio del equipo (' + promedioEquipo + '%), que tampoco cumple la meta.';
    } else if (datos.tasa === promedioEquipo) {
      compEquipo = ' Tu numero esta igual al promedio del equipo (' + promedioEquipo + '%)'
        + (promedioEquipo > meta ? ', que tampoco cumple la meta.' : '.');
    } else {
      compEquipo = ' El promedio del equipo (' + promedioEquipo + '%) es un poco mejor que tu numero.';
    }
  }
  let rankingFrase = '';
  if (datos.ranking) {
    const enBuenLugar = datos.ranking <= Math.ceil(datos.rankingTotal / 3);
    rankingFrase = 'Estas en el puesto <b>' + datos.ranking + ' de ' + datos.rankingTotal + '</b> tecnicos'
      + (enBuenLugar ? ', entre los mejores del equipo.' : '.');
  }

  contadorDetalle++;
  const idDetalle = 'detalle' + contadorDetalle;

  let html = '<div class="cabecera"><span class="icono">' + icono + '</span><h2>' + titulo + '</h2></div>';
  html += '<p class="explica">' + explicacion + '</p>';
  html += '<div class="estado-pill ' + est.clase + '">' + est.emoji + ' ' + est.texto + '</div>';
  html += barraTasa(datos.tasa, meta, est.clase);
  const problemaVerbo = datos.reincidencias === 1 ? 'tuvo un problema' : 'tuvieron problemas';
  html += '<p class="frase-clave">De tus <b>' + datos.total + '</b> ' + fraseFormula + ', <b>' + datos.reincidencias + '</b> '
    + problemaVerbo + ' despues (' + datos.tasa + '%).</p>';
  html += '<p class="frase-clave">' + cumpleFrase + compEquipo + '</p>';
  if (rankingFrase) {
    html += '<p class="frase-clave">' + rankingFrase + '</p>';
  }
  if (datos.causaFrecuente) {
    html += '<div class="callout">💡 <b>Para mejorar:</b> la mayoria de tus casos con problema fueron por "' + datos.causaFrecuente + '" ('
      + datos.causaFrecuenteCasos + ' caso' + (datos.causaFrecuenteCasos === 1 ? '' : 's') + '). Poner atencion extra ahi te deberia ayudar a bajar tu numero.</div>';
  }

  html += '<div class="detalle-toggle" onclick="toggleDetalle(\\'' + idDetalle + '\\')">Ver el detalle en numeros <span id="' + idDetalle + 'Flecha">▾</span></div>';
  html += '<div class="detalle-body" id="' + idDetalle + '">';
  html += '<div class="fila-dato"><span class="k">Casos totales evaluados</span><span class="v">' + datos.total + '</span></div>';
  html += '<div class="fila-dato"><span class="k">Casos con problema</span><span class="v">' + datos.reincidencias + '</span></div>';
  if (datos.diasPromedio != null) {
    html += '<div class="fila-dato"><span class="k">Dias promedio hasta el problema</span><span class="v">' + datos.diasPromedio + ' dias</span></div>';
  }
  if (datos.mismoPct != null) {
    html += '<div class="fila-dato"><span class="k">% que tu mismo corregiste de nuevo</span><span class="v">' + datos.mismoPct + '%</span></div>';
  }
  html += '</div>';
  return html;
}

function toggleDetalle(id) {
  const el = document.getElementById(id);
  const flecha = document.getElementById(id + 'Flecha');
  const abierto = el.classList.toggle('abierto');
  flecha.textContent = abierto ? '▴' : '▾';
}
window.toggleDetalle = toggleDetalle;

function mostrarPerfil(t) {
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('appBox').style.display = 'block';
  document.getElementById('saludo').textContent = '👋 Hola, ' + titleCase(t.nombre);
  document.getElementById('agenciaTecnico').textContent = t.agencia ? ('Agencia: ' + titleCase(t.agencia)) : '';

  const estados = [];
  if (t.reincidencias) estados.push(estado(t.reincidencias.tasa, DATA.metaReincidencias).clase);
  if (t.infancia) estados.push(estado(t.infancia.tasa, DATA.metaInfancia).clase);
  if (t.nps && DATA.metaNps != null) estados.push(estadoNps(t.nps.nps, DATA.metaNps).clase);
  let claseGeneral = 'ok', mensajeGeneral = '🎉 <b>Vas muy bien este mes.</b> <span>Tus dos indicadores estan dentro de la meta. Sigue asi.</span>';
  if (estados.includes('bad')) {
    claseGeneral = 'bad';
    mensajeGeneral = '🔴 <b>Estas muy fuera de la meta en algun indicador.</b> <span>Mira el detalle abajo para saber en que enfocarte.</span>';
  } else if (estados.includes('warn')) {
    claseGeneral = 'warn';
    mensajeGeneral = '⚠️ <b>Estas fuera de la meta en algun indicador.</b> <span>Revisa el detalle abajo para saber en cuanto y en que enfocarte.</span>';
  }
  const emojiGeneral = claseGeneral === 'ok' ? '🎉' : (claseGeneral === 'warn' ? '⚠️' : '🔴');
  document.getElementById('resumenGeneral').innerHTML =
    '<div class="resumen-general ' + claseGeneral + '"><div class="emoji">' + emojiGeneral + '</div><div class="texto">' + mensajeGeneral + '</div></div>';

  document.getElementById('seccionReincidencias').innerHTML = bloqueReporte({
    icono: '🔁', titulo: 'Repetido Reparado',
    explicacion: 'Mide si una reparacion tuya vuelve a fallar antes de 30 dias. Mientras mas bajo, mejor.',
    meta: DATA.metaReincidencias, promedioEquipo: DATA.promedioEquipoReincidencias, datos: t.reincidencias,
    fraseFormula: 'reparaciones que hiciste',
  });
  document.getElementById('seccionInfancia').innerHTML = bloqueReporte({
    icono: '🏠', titulo: 'Averias de Infancia',
    explicacion: 'Mide si una instalacion tuya necesita una reparacion poco despues de instalada. Mientras mas bajo, mejor.',
    meta: DATA.metaInfancia, promedioEquipo: DATA.promedioEquipoInfancia, datos: t.infancia,
    fraseFormula: 'instalaciones que hiciste',
  });
  document.getElementById('seccionNps').innerHTML = bloqueNps(t);
}

function intentarLogin() {
  const key = normalizarTexto(document.getElementById('inputNombre').value);
  const pass = (document.getElementById('inputPass').value || '').trim().toUpperCase();
  const errorBox = document.getElementById('loginError');
  const t = DATA.tecnicos[key];
  if (!t || !key || t.clave !== pass) {
    errorBox.textContent = 'Nombre o clave incorrectos. Revisa que este bien escrito tu nombre y apellido.';
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

<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(()=>{}));
}
</script>

</body>
</html>`;
}

main().catch((err) => {
  console.error('ERROR:', err.message);
  process.exitCode = 1;
});
