# DataDB

Cliente de bases de datos de escritorio para macOS, inspirado en la experiencia de JetBrains DataGrip:
multi-conexión, explorador de esquema, consola SQL con autocompletado que entiende tus claves foráneas,
rejilla de resultados rápida, diagramas ER y un asistente de IA para tareas SQL.

**Código abierto (MIT).** Úsalo, mejóralo y manda tus features.

[**⬇ Descargar DataDB para macOS (Apple Silicon)**](https://github.com/bit-armando/datadb/releases/latest)

![Consola SQL con resultados](docs/screenshots/01-consola.png)

## Contenido

- [Características](#características)
  - [Conexiones y motores](#conexiones-y-motores)
  - [Consola SQL](#consola-sql)
  - [Resultados y edición de datos](#resultados-y-edición-de-datos)
  - [Explorador, diagramas y DDL](#explorador-diagramas-y-ddl)
  - [MongoDB](#mongodb)
  - [Asistente de IA](#asistente-de-ia)
  - [Productividad](#productividad)
- [Personalización](#personalización)
- [Instalación](#instalación)
- [Desarrollo](#desarrollo)
- [Contribuir](#contribuir)

## Características

### Conexiones y motores

- **PostgreSQL, MySQL / MariaDB, SQL Server y MongoDB** en la misma app, con varias conexiones abiertas a la vez.
- **Contraseñas cifradas** con el Llavero de macOS (`safeStorage`); el archivo de conexiones nunca las guarda.
- **TLS** configurable, **túnel SSH** (contraseña o llave) y **modo solo lectura** por conexión, que bloquea
  INSERT/UPDATE/DELETE/DDL.
- **Autenticación IAM de RDS/Aurora** (PostgreSQL y MySQL): el token se firma al conectar, sin guardar contraseña.
  Ver [Autenticación IAM](#autenticación-iam-rdsaurora).
- **Color por conexión** que tiñe el explorador y las pestañas, para distinguir producción de desarrollo de un vistazo.
- Cada consola tiene **su propia conexión y base de datos**; si la sesión caduca, se reconecta con un clic desde
  cualquier vista.

![Conexiones](docs/screenshots/05-conexiones.png)

### Consola SQL

- Editor propio con números de línea, resaltado de sintaxis y **contorno de la sentencia actual**.
- **Autocompletado por contexto**: después de `FROM` sugiere tablas, después de un alias sus columnas, y en un
  `JOIN … ON` propone la condición correcta a partir de las **claves foráneas**.
- **Ejecutar la sentencia actual** (`⌘↵`) o **todo el script** (`⌘⇧↵`): cada sentencia abre su propia pestaña de
  resultados.
- **Plan de ejecución visual** (`⌘⇧J`): árbol de nodos con costo y filas estimadas, marca los nodos costosos y
  ofrece **«Optimizar con IA»**.
- **Formatear SQL** (`⌘⇧F`), **transacciones** automáticas o manuales con commit / rollback, y cancelar consultas
  en curso.
- **Historial** de todo lo ejecutado (con duración y filas) y **log de SQL**.
- **Consultas guardadas** por conexión, con buscador; la pestaña toma el nombre de la consulta.

| Autocompletado con JOIN por clave foránea | Plan de ejecución |
| --- | --- |
| ![Autocompletado](docs/screenshots/02-autocompletado.png) | ![EXPLAIN](docs/screenshots/08-explain.png) |
| **Historial y varias pestañas de resultados** | **Consultas guardadas** |
| ![Historial](docs/screenshots/09-historial-y-resultados.png) | ![Guardadas](docs/screenshots/10-consultas-guardadas.png) |

### Resultados y edición de datos

- Rejilla rápida (canvas) que maneja **miles de filas** sin trabarse.
- **Filtros por columna**, ordenamiento, columnas redimensionables que se recuerdan por tabla y **colores por tipo
  de dato**.
- **Editar celdas en línea**, agregar, duplicar y borrar filas: los cambios quedan **pendientes** hasta que pulsas
  *Guardar* (o *Descartar*).
- **Panel «Valor»** para ver y editar valores largos (texto, JSON) de la celda seleccionada.
- **Topes rápidos de filas** (`LIMIT`), copiar la selección como TSV u otros formatos, y **exportar** a CSV, JSON,
  Markdown o `INSERT` SQL con vista previa.

| Vista de tabla | Edición con cambios pendientes y panel de valor |
| --- | --- |
| ![Vista de tabla](docs/screenshots/04-tabla.png) | ![Edición](docs/screenshots/16-edicion-de-datos.png) |

### Explorador, diagramas y DDL

- **Explorador de esquema** con esquemas, tablas y **favoritos** (filtro «solo favoritos»).
- **Diagramas ER interactivos**: parte de una tabla, agrega las relacionadas con un clic, reorganiza y
  **exporta a PNG**.
- **Editor visual de tablas**: define columnas, tipos, PK, nulos y defaults; el `CREATE TABLE` se genera en vivo.
  También plantillas para **vistas, índices, triggers y funciones**, y *Copiar DDL* de cualquier tabla.

| Diagrama ER | Nueva tabla (editor visual) |
| --- | --- |
| ![Diagrama ER](docs/screenshots/03-diagrama-er.png) | ![Nueva tabla](docs/screenshots/17-nueva-tabla.png) |

### MongoDB

- Explorador de colecciones y vista de documentos en **lista o JSON**, con paginación.
- **Filtros** con sintaxis de Mongo (`{ calificacion: { $gte: 4 } }`) y sugerencias de campos.
- Crear, editar y borrar documentos.

![MongoDB](docs/screenshots/15-mongodb.png)

### Asistente de IA

Opcional, con tu propia clave de [OpenRouter](https://openrouter.ai) y el modelo que elijas.

- **Texto a SQL** (`⌘⇧Y`) usando tu esquema como contexto.
- **Chat** que conoce las tablas de la conexión activa, con acciones rápidas: **explicar, convertir entre dialectos
  y optimizar**.
- **Corregir errores** desde el banner de error de una consulta.
- **Datos con IA**: resumir filas de un resultado (pide confirmación antes de mandar datos) o generar SQL de
  agregación.
- El SQL generado **nunca se ejecuta sin que tú lo confirmes**.

| Chat con contexto del esquema | Generar SQL |
| --- | --- |
| ![IA chat](docs/screenshots/13-ia-chat.png) | ![Generar SQL](docs/screenshots/14-ia-generar-sql.png) |

### Productividad

- **Paleta de comandos** (`⌘K`): acciones, funciones de IA y salto directo a cualquier tabla.
- **41 atajos compatibles con DataGrip** (ejecutar, nueva consola, plan, formatear, diagrama, historial…) y un
  diálogo que los lista todos.
- **Ventanas de herramientas** (Explorador, Guardadas, IA, Resultados, Historial, Valor) que se muestran u ocultan
  como en los IDE de JetBrains.
- Menú nativo de macOS y la app recuerda pestañas, tamaño de ventana y layout entre sesiones.

| Paleta de comandos | Atajos de teclado |
| --- | --- |
| ![Paleta](docs/screenshots/11-paleta-de-comandos.png) | ![Atajos](docs/screenshots/12-atajos.png) |

## Personalización

Todo desde **Apariencia** (botón de la barra superior o menú *View*), con **vista previa en vivo**: los cambios se
aplican al instante.

- **Tema**: 31 temas (22 oscuros y 9 claros: Darcula, Islands Dark, One Dark, Monokai, Nord, Tokyo Night, Dracula,
  Catppuccin, Gruvbox, Rosé Pine, Everforest, Kanagawa, Ayu, Material, Night Owl, Solarized, GitHub, alto
  contraste…), buscador de temas y **modo claro, oscuro o seguir al sistema**.
- **Colores**: **tinte de conexión** con intensidad ajustable, para que cada entorno se vea distinto.
- **Rejilla de datos**: cuadrícula **marcada, suave o sin líneas** y colores por tipo de dato.
- **Ventana**: densidad **New UI** (24/40 px) o **Clásica** (20/32 px), barra de ventanas de herramientas
  **vertical o en el header**, y restablecer el layout.
- **Avanzado**: elige el tema base y **edita cada color** por grupos (chrome, interacción, pestañas, rejilla,
  editor y sintaxis SQL). Puedes **importar y exportar** tu tema y restablecerlo cuando quieras.

| Temas | Tinte de conexión |
| --- | --- |
| ![Temas](docs/screenshots/06-apariencia.png) | ![Colores](docs/screenshots/20-personalizacion-colores.png) |
| **Rejilla de datos** | **Ventana y densidad** |
| ![Rejilla](docs/screenshots/21-personalizacion-rejilla.png) | ![Ventana](docs/screenshots/22-personalizacion-ventana.png) |
| **Avanzado: cada color editable** | **Tokyo Night** |
| ![Avanzado](docs/screenshots/23-personalizacion-avanzado.png) | ![Tokyo Night](docs/screenshots/18-tema-tokyo-night.png) |
| **Tema claro** | |
| ![Tema claro](docs/screenshots/07-tema-claro.png) | |

## Instalación

1. Descarga el `.dmg` más reciente desde
   [Releases](https://github.com/bit-armando/datadb/releases/latest).
2. Ábrelo y arrastra **DataDB** a **Aplicaciones**.
3. La primera vez: **clic derecho sobre DataDB ▸ Abrir ▸ Abrir** (la app no está notarizada por
   Apple, ver abajo). Las siguientes veces abre con doble clic.

Si macOS dice que la app «está dañada» o no deja abrirla:

```bash
xattr -dr com.apple.quarantine /Applications/DataDB.app
```

**Requisitos**: macOS 12 o superior en Apple Silicon (M1 o posterior). No hace falta Node, Homebrew ni
Docker: todo va dentro del `.dmg`. Más detalles en [README-instalacion.md](README-instalacion.md).

> **¿Por qué el aviso de «desarrollador no identificado»?** Firmar y notarizar con Apple requiere una
> cuenta de desarrollador de pago. El `.dmg` se firma *ad-hoc*; el código es el de este repo y puedes
> compilarlo tú mismo (ver abajo).

### Dónde guarda tus datos

`~/Library/Application Support/DataDB/`: conexiones (sin contraseñas), historial, consultas guardadas y
preferencias. Las contraseñas y la clave de IA van cifradas con `safeStorage` de Electron (Llavero de
macOS) y no viajan a otra Mac.

## Desarrollo

Stack: Electron + Vite (electron-vite) + React 19 + TypeScript + Tailwind v4.

Requisitos: macOS y Node.js `^20.19` o `>=22.12` (recomendado: Node 22 o 24 LTS).

```bash
git clone https://github.com/bit-armando/datadb.git
cd datadb
npm install
npm run dev          # abre la app en modo desarrollo
```

| Comando | Qué hace |
| --- | --- |
| `npm run dev` | Arranca la app con recarga en caliente. |
| `npm run lint` | ESLint. |
| `npm run typecheck` | `tsc --noEmit` (electron-vite no comprueba tipos). |
| `npm test` | Tests (`tsx --test` sobre `src/**/*.test.ts` y `electron/**/*.test.ts`). |
| `npm run build` | Compila el bundle de Electron en `out/`. |
| `npm run dist` | Genera `release/DataDB-<versión>-arm64.dmg`. |
| `npm run instalar` | Compila y copia la app a `/Applications` (útil para probar cambios). |

Antes de abrir un PR: `npm run lint && npm run typecheck && npm test && npm run build`.

Para probar contra bases desechables sin tocar tus datos reales, arranca la app con un directorio de
datos aislado (ruta absoluta):

```bash
DATADB_DATA_DIR=/tmp/datadb-pruebas npm run dev
```

### Estructura

```
electron/        Proceso main + preload + utilityProcess de base de datos
  main.ts          ventana, broker renderer↔worker, cifrado de secretos (safeStorage)
  preload.ts       superficie IPC acotada que se expone al renderer
  db-worker.ts     utilityProcess que aloja sesiones, pools y drivers de BD
  broker.ts        correlación de peticiones/respuestas con el worker
src/
  renderer/        entrada del renderer (main.tsx, globals.css, fonts.css)
  components/      componentes React (editor SQL, rejilla, árbol, diálogos…)
  server/          lógica del worker: drivers de BD, handlers IPC, IA, perfiles
  shell/           pestañas, layout y atajos de teclado
  theme/           sistema de temas
  icons/           iconos (set de IntelliJ, Apache 2.0) e iconos propios
index.html       entrada de Vite
```

Flujo: `renderer --invoke--> main (valida) --postMessage--> db-worker --> drivers`. `main` no toca
ninguna base de datos: valida el remitente, aplica la lista blanca de canales y reenvía.

## Autenticación IAM (RDS/Aurora)

En la conexión marca **IAM (AWS)**, indica la región (se propone a partir del host) y, si no usas las credenciales por
defecto, el perfil de `~/.aws`. DataDB firma un token de 15 minutos con la cadena estándar de credenciales de AWS
(perfiles, SSO, variables de entorno) cada vez que abre una conexión. RDS exige TLS: el modo **Requerido** basta; con
**Verificar CA** elige el [bundle de RDS](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem).

Requisitos del lado de la base:

- Cluster con IAM habilitado y un usuario de base de datos preparado: PostgreSQL `GRANT rds_iam TO usuario;`,
  MySQL `CREATE USER usuario IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS';`.
- Política IAM con `rds-db:connect` sobre `arn:aws:rds-db:REGIÓN:CUENTA:dbuser:cluster-XXXX/usuario`
  (el ID de recurso del cluster, no su nombre; con RDS Proxy, el `prx-…`).
- Si usas el túnel SSH, ten en cuenta que aún no aplica a PostgreSQL/MySQL; conecta por VPN o a un endpoint alcanzable.
- Si la sesión SSO venció, la app lo indica: corre `aws sso login`.

## Asistente de IA (opcional)

La IA usa [OpenRouter](https://openrouter.ai): configura tu clave en **Ajustes de IA** dentro de la app
(se guarda cifrada en el Llavero). Cada quien usa su propia clave. En desarrollo también se acepta la
variable `OPENROUTER_API_KEY` (ver `.env.example`).

- **Texto a SQL** (`⌘⇧Y`), **corregir errores** desde el banner de error, y panel lateral para
  **explicar, convertir y optimizar**.
- **Selector de modelo** con favoritos; los modelos DeepSeek se destacan como opción barata.
- Por defecto solo se envía el **esquema** (tablas, columnas, tipos, FKs), nunca filas. La única
  excepción es «Resumir filas», que pide confirmación indicando cuántas filas se enviarán.
- El SQL generado nunca se ejecuta solo, hay avisos para sentencias destructivas, y en conexiones de
  solo lectura se bloquean las sentencias que no sean `SELECT`.

## Contribuir

¡Bienvenidas las contribuciones! Lee [CONTRIBUTING.md](CONTRIBUTING.md) para el flujo de issues y PRs.

## Licencia

[MIT](LICENSE). Los iconos de `src/icons/intellij/` provienen de
[JetBrains/intellij-community](https://github.com/JetBrains/intellij-community) bajo Apache 2.0 (ver
`src/icons/intellij/NOTICE.txt`). DataDB no está afiliado a JetBrains; DataGrip es marca de
JetBrains s.r.o.
