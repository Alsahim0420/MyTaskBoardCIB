# Tablero gestión de tareas

Kanban para llevar el seguimiento de **historias de usuario (HU)** y las **HA** creadas para cada una.
Cada usuario tiene su propia cuenta y solo ve y gestiona sus HU.

**En producción:** https://tablero-gestion-de-tareas.vercel.app

## Qué hace

- Tres estados: **Por hacer → En desarrollo → Creada**. Se mueven arrastrando o con ◀ ▶ (móvil).
- Por cada HU: meta de **HA esperadas** según su complejidad, lista de HA (ID obligatorio, título opcional), notas e **historial automático** de cambios.
- Crear, editar (ID y título) y eliminar HU.
- Ingreso con correo y contraseña; los datos de cada usuario están aislados con Row Level Security.
- Cambios en tiempo real entre dispositivos.
- Tema claro / oscuro con transición animada; paleta amarilla y negra.

## Estructura

```
index.html            ← toda la app (HTML + CSS + JS, sin build)
config.js             ← URL y publishable key de Supabase
supabase/schema.sql   ← tablas, políticas RLS, triggers de historial y realtime
```

Sin `config.js` configurado, la app abre en **modo demo** (guarda solo en el navegador).

## Stack

- **Frontend:** HTML/CSS/JS estático + [`@supabase/supabase-js`](https://github.com/supabase/supabase-js) por CDN.
- **Backend:** Supabase (Postgres + Auth + Realtime).
- **Hosting:** Vercel (sitio estático, sin build).

## Montarlo desde cero

1. **Supabase:** crea un proyecto y ejecuta `supabase/schema.sql` en el SQL Editor.
2. Copia la **Project URL** y la **publishable key** (Project Settings → API) en `config.js`.
   La key es pública por diseño; la seguridad la dan las políticas RLS.
3. **Auth → URL Configuration:** pon la URL del sitio en *Site URL* y en *Redirect URLs*.
   Opcional: desactiva *Confirm email* para que las cuentas queden activas al registrarse.
4. **Vercel:** importa este repositorio (framework *Other*, sin build command). Cada push a `main` se publica solo.

## Modelo de datos

| Tabla | Qué guarda |
|---|---|
| `hu` | HU por usuario: `codigo`, `titulo`, `estado`, `ha_esperadas`, `orden`, `notas` |
| `ha` | HA de cada HU: `codigo` (obligatorio, único por HU), `titulo` (opcional) |
| `hu_historial` | Registro automático de cambios de estado, meta y HA |

Todas tienen `owner_id` y políticas RLS que limitan lectura y escritura al dueño.
