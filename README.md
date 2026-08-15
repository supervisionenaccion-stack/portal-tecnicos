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
├── index.html          ← pagina publicada (login + vista personal)
├── generar_portal.js   ← genera index.html a partir de los CSV en ..\bbdd\
├── logo-cobra.png
└── .gitignore
```

## Actualizar

1. Reemplaza los CSV en `C:\Reiterados\bbdd\` (los mismos que usa "Supervisor").
2. Corre `node generar_portal.js` desde esta carpeta (o el .bat que lo automatiza).
3. `git add`, `git commit`, `git push` para publicar la actualizacion.

La clave de cada tecnico se recalcula desde el RUT en cada corrida, asi que
se mantiene igual mientras su RUT no cambie.
