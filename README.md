# Portal de Tecnicos — COBRA

Cada tecnico entra con su **nombre y apellido** + una **clave de 4 digitos** (los
ultimos 4 digitos de su RUT) y ve solo sus propios indicadores de Repetido
Reparado y Averias de Infancia. No requiere que compartas ni publiques su RUT
completo: el RUT solo se usa al generar el sitio, en tu computador, para
calcular esa clave y cruzar los dos reportes.

Este es un filtro liviano pensado para que cada tecnico vea comodamente su
propia informacion, no un sistema de seguridad real (es un sitio estatico,
sin servidor).

## Estructura

```
portal-tecnicos/
├── index.html                         ← pagina publicada, siempre el mes actual
├── index_2026-08.html, ...            ← copia archivada de cada mes (historial)
├── meses.json                         ← lista de meses disponibles para el selector
├── generar_portal.js                  ← genera todo lo anterior a partir de los CSV en ..\bbdd\
├── Credenciales_Tecnicos_NO_SUBIR.xlsx ← usuario/clave de cada tecnico (SOLO local, no se sube)
├── manifest.json, sw.js, icon-*.png   ← PWA (instalable en el celular)
├── logo-cobra.png
└── .gitignore
```

El mes se toma de `partition_date` dentro del CSV (la fecha del snapshot de
datos), no de la fecha del sistema. Cada corrida deja una copia fechada
ademas de actualizar `index.html`, y aparece un selector "📁 Meses
disponibles" en la pagina apenas haya 2 o mas meses guardados -- igual que
en "Supervisor".

## Actualizar

1. Reemplaza los CSV en `C:\Reiterados\bbdd\` (los mismos que usa "Supervisor").
2. Corre `node generar_portal.js` desde esta carpeta (o el .bat que lo automatiza).
3. `git add`, `git commit`, `git push` para publicar la actualizacion.

La clave de cada tecnico se recalcula desde el RUT en cada corrida, asi que
se mantiene igual mientras su RUT no cambie.

## Repartir los accesos a los tecnicos

Cada corrida genera `Credenciales_Tecnicos_NO_SUBIR.xlsx` con el nombre, la
agencia, el usuario (nombre a ingresar) y la clave de cada tecnico. Este
archivo **no se sube a GitHub** (esta en `.gitignore`) -- es solo para que
tu se lo repartas a cada tecnico (por WhatsApp, por ejemplo).

Si dos tecnicos distintos comparten el mismo nombre corto, el script se lo
advierte en la consola al generar y le agrega un numero al segundo (ej.
"Marcos Aguilar 2") -- revisa la consola si ves esa alerta y avisale al
tecnico su usuario exacto.
