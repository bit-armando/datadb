/**
 * Fase 70 (T2, R70) — la BARRA SUPERIOR ÚNICA de la ventana.
 *
 * La maqueta aprobada (`design/propuesta-ui-ventana.png`, Stitch `projects/9447415423411079422`)
 * sustituye el header viejo (dos alturas, botones grandes de texto) por UNA barra de aplicación de
 * ~40 px, con — de izquierda a derecha:
 *
 *   1. la franja de los semáforos de macOS (78 px, `[-webkit-app-region:drag]`);
 *   2. el selector de CONEXIÓN ACTIVA: desplegable real con logo del motor, punto de color del
 *      perfil, nombre y chevron. La lista son los perfiles guardados; conectar/cambiar/desconectar
 *      usa el mismo `connectProfile`/`handleDisconnectConsole` que ya vive en la barra por consola
 *      (`console-connection-bar.tsx`) — aquí NO se duplica, se reusa por evento (ver abajo);
 *   3. el selector de BASE/ESQUEMA EFECTIVO de la consola activa (el `Select` de database que
 *      estaba en la barra de la consola);
 *   4. las acciones de consola: Ejecutar / Cancelar / EXPLAIN / Formatear / Tx: auto;
 *   5. a la derecha: Conexiones… (abre el modal de T1), nueva consola (+), ajustes de apariencia,
 *      indicador de IA.
 *
 * REGLA DE FASE (la misma de la fase 6): CERO lógica nueva. Los botones disparan los MISMOS
 * eventos `gestordb:*` que ya atienden el menú nativo (`use-menu-actions.ts`) y la paleta de
 * comandos, y que `sql-editor.tsx`/`app-shell.tsx` ya escuchan en `window`. Un botón aquí y la
 * entrada del menú Query ▸ Execute hacen EXACTAMENTE lo mismo porque son el mismo evento.
 *
 * Lo que NO se construye de la maqueta (PLAN.md §2): los menús Archivo/Editar en la ventana
 * (macOS da el menú nativo) y los atajos impresos en las etiquetas (van en tooltips).
 */
import * as React from "react";

import { IjIcon } from "@/components/ij-icon";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useAppState,
  useAppDispatch,
  useActiveConsole,
} from "@/hooks/use-app-state";
import { useConectarConsola } from "@/hooks/use-conectar-consola";
import {
  connect as apiConnect,
  listProfiles,
} from "@/lib/api";
import { switchDatabaseWithConsoleReconnect } from "@/lib/session-reconnect-client";
import type { ConnectionProfile } from "@/lib/types";
import { DEFAULT_PROFILE_COLOR } from "@/lib/profile-colors";
import { toast } from "sonner";
import { IconoMotor } from "./icono-motor";

/** Dispara el evento global que ya atiende el dueño de la acción (regla de la fase 6/70). */
function emitir(nombre: string): void {
  window.dispatchEvent(new CustomEvent(nombre));
}

/** Punto de color del PERFIL (el que el usuario eligió al crearlo). */
function PuntoDeConexion({ color }: { color: string }) {
  return (
    <span
      className="size-2.5 shrink-0 rounded-full ring-1 ring-black/20 dark:ring-white/20"
      style={{ backgroundColor: color }}
    />
  );
}

export function AppTopBar({
  onOpenConnections,
  onOpenAppearance,
  children,
}: {
  /** Abre el modal «Conexiones» (T1). */
  onOpenConnections: () => void;
  /** Abre el diálogo de apariencia (tema/densidad/paleta). */
  onOpenAppearance: () => void;
  /** Los stripes de tool windows (los mismos que hoy viven en el header viejo). */
  children?: React.ReactNode;
}) {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const activeConsole = useActiveConsole();
  const session = activeConsole.session;
  const consoleId = activeConsole.id;
  /**
   * R91: lo que se PINTA es la conexión de la consola, viva o dormida (atada a un perfil y una base,
   * sin sesión: lo normal al reabrir la app). Ejecutar con una dormida la conecta sola.
   * R101: `conexion` sale del hook, que la calcula igual (`connectionOf`) y trae además la
   * reconexión de la dormida — el botón «Conectar» de abajo.
   */
  const { conectar, conectando, conexion } = useConectarConsola();

  const [profiles, setProfiles] = React.useState<ConnectionProfile[]>([]);
  /**
   * Estado SÓLO del desplegable de cambio de perfil: mientras `connectProfile` corre, el menú se
   * deshabilita. No es el `conectando` del hook (ése es del botón «Conectar»); mezclarlos haría que
   * conectar la dormida bloqueara el menú, o cambiar de perfil no lo bloqueara.
   */
  const [connecting, setConnecting] = React.useState(false);

  // Carga de perfiles para el desplegable de conexión (igual que ConsoleConnectionBar).
  const loadProfiles = React.useCallback(async () => {
    try {
      setProfiles(await listProfiles());
    } catch (err) {
      toast.error(String(err));
    }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProfiles();
  }, [loadProfiles]);

  /** Conecta la consola con foco a un perfil guardado (mismo camino que la barra por consola). */
  async function connectProfile(profile: ConnectionProfile) {
    setConnecting(true);
    try {
      const newSession = await apiConnect(profile.id);
      dispatch({ type: "SET_SESSION", payload: { consoleId, session: newSession } });
      toast.success(`Consola conectada a ${newSession.name}`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setConnecting(false);
    }
  }

  async function handleSwitchDatabase(database: string) {
    // R91: con la consola dormida, cambiar de base solo cambia a dónde se conectará (sin conectar).
    if (!session && activeConsole.binding) {
      if (database === activeConsole.binding.database) return;
      dispatch({ type: "SET_BINDING", payload: { consoleId, binding: { ...activeConsole.binding, database } } });
      return;
    }
    if (!session || database === session.database) return;
    try {
      await switchDatabaseWithConsoleReconnect(
        {
          consoleId,
          session,
          binding: activeConsole.binding,
          onSessionChange: (next) =>
            dispatch({ type: "SET_SESSION", payload: { consoleId, session: next } }),
        },
        database
      );
    } catch (err) {
      toast.error(String(err));
    }
  }

  return (
    <header
      className="flex h-10 shrink-0 items-center gap-2 border-b border-gdb-sep bg-gdb-chrome px-3 text-xs text-gdb-fg [-webkit-app-region:drag]"
      data-testid="app-top-bar"
    >
      {/* Franja de los semáforos de macOS (titleBarStyle hiddenInset): la pinta encima el SO. */}
      <div aria-hidden className="w-[78px] shrink-0" />

      {/* --- 1. Desplegable de conexión activa ---------------------------------- */}
      <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
        {conexion && !conexion.live && (
          /*
            R101: la consola está DORMIDA (sesión expirada o recién abierta) — el mismo «Conectar»
            que antes sólo existía dentro del modal de Conexiones, ahora visible en cualquier vista.
            El desplegable de al lado sigue para CAMBIAR de perfil; esto reconecta al de la atadura.
          */
          <Button
            size="sm"
            onClick={() => void conectar()}
            disabled={conectando}
            title={`Conectar esta consola a ${conexion.name}${conexion.database ? ` · ${conexion.database}` : ""}`}
            className="h-7 gap-1.5 bg-primary px-2.5 text-primary-foreground hover:bg-primary/90"
            data-testid="conectar-consola"
          >
            <IjIcon name="connect" />
            {conectando ? "Conectando…" : "Conectar"}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                disabled={connecting}
                title={
                  conexion && !conexion.live
                    ? `${conexion.name}: se conecta al ejecutar (cambiar, desconectar)`
                    : "Conexión de la consola activa (cambiar, desconectar)"
                }
                className="h-7 max-w-[220px] gap-1.5 rounded-md border-gdb-sep bg-gdb-editor/50 px-2.5 font-medium text-gdb-fg hover:bg-gdb-hover hover:text-gdb-fgstrong"
              >
                {conexion ? (
                  <>
                    {/* F2: la marca del motor identifica la conexión de un vistazo; el punto de
                        color sigue siendo el del PERFIL (es el que el usuario eligió). R91: dormida,
                        la marca va atenuada — está elegida pero aún no conectada. */}
                    <span className={conexion.live ? undefined : "opacity-55"} data-testid="conexion-consola" data-viva={conexion.live ? "si" : "no"}>
                      <IconoMotor tipo={conexion.type} />
                    </span>
                    <PuntoDeConexion color={conexion.color || DEFAULT_PROFILE_COLOR} />
                    <span className="max-w-[130px] truncate">{conexion.name}</span>
                  </>
                ) : (
                  <>
                    <IjIcon name="connect" />
                    <span>{connecting ? "Conectando…" : "Sin conexión"}</span>
                  </>
                )}
                <IjIcon name="chevronDown" className="ml-0.5 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="min-w-56">
            {/*
              El rótulo va DENTRO de un `DropdownMenuGroup`: `MenuPrimitive.GroupLabel` sin su
              `Group` lanza «Base UI error #31» al montar el menú y React desmonta la ventana
              completa — el usuario lo veía como una pantalla en blanco al pulsar la conexión.
              Los otros dos menús del repo ya lo hacían así.
            */}
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Cambiar conexión de esta consola
              </DropdownMenuLabel>
              {profiles.length === 0 ? (
                <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                  No hay perfiles guardados
                </DropdownMenuItem>
              ) : (
                profiles.map((profile) => (
                  <DropdownMenuItem
                    key={profile.id}
                    onClick={() => void connectProfile(profile)}
                    className="gap-2"
                    disabled={connecting}
                  >
                    <IconoMotor tipo={profile.type} />
                    <PuntoDeConexion color={profile.color || DEFAULT_PROFILE_COLOR} />
                    <span className="flex-1 truncate">{profile.name}</span>
                    {profile.id === conexion?.profileId && (
                      <span className="text-[10px] text-muted-foreground">actual</span>
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenConnections} className="gap-2">
              <IjIcon name="add" />
              Nueva conexión…
            </DropdownMenuItem>
            {conexion && (
              <DropdownMenuItem
                variant="destructive"
                className="gap-2"
                onClick={() => emitir("gestordb:disconnect")}
              >
                <IjIcon name="disconnect" />
                Desconectar esta consola
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* --- 2. Selector de base/esquema efectivo (con sesión, o la guardada si está dormida) -- */}
        {conexion && (
          <Select
            value={conexion.database || ""}
            onValueChange={(v) => v && void handleSwitchDatabase(v)}
          >
            <SelectTrigger
              size="sm"
              aria-label="Base de datos de la consola activa"
              className="h-7 min-w-[110px] max-w-[200px] gap-1.5 rounded-md border-gdb-border bg-gdb-field px-2 text-xs text-gdb-fgstrong hover:bg-gdb-hover"
            >
              {/*
                Cilindro NEUTRO, no la marca del motor: el motor ya lo identifica el botón de
                conexión que está justo a la izquierda, y aquí lo que se elige es la BASE.
              */}
              <IjIcon name="database" className="shrink-0 opacity-70" />
              {/*
                El nombre se pinta a mano en vez de con `SelectValue`: con el `placeholder` solo, el
                trigger caía a «Database» mientras la lista de bases no había llegado; y con hijos
                de función este `SelectValue` (base-ui) no pintaba nada — medido: el botón quedaba
                en «▼». Aquí siempre se ve en qué base está la consola.
              */}
              <span className="truncate">{conexion.database || "—"}</span>
              {/* El chevron lo pinta el propio SelectTrigger: añadir otro dejaba dos flechas. */}
            </SelectTrigger>
            <SelectContent className="min-w-[--anchor-width] max-w-xs border-gdb-border bg-popover p-1 text-gdb-fg shadow-lg">
              {state.databases.map((db) => (
                <SelectItem
                  key={db}
                  value={db}
                  className="rounded px-2 py-1 text-xs text-gdb-fg focus:bg-gdb-listsel focus:text-gdb-fgstrong data-[selected]:bg-primary/15 data-[selected]:text-primary"
                >
                  <span className="flex items-center gap-2">
                    <IjIcon name="database" />
                    <span className="truncate">{db}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* --- 3. Derecha: Command Palette, Conexiones…, +, ajustes, IA ----------- */}
      <div className="ml-auto flex items-center gap-1.5 [-webkit-app-region:no-drag]">
        {children}
        <span aria-hidden className="mx-0.5 h-4 w-px bg-gdb-sep" />
        <Button
          size="sm"
          variant="outline"
          onClick={() => emitir("gestordb:command-palette")}
          title="Paleta de comandos (⌘K)"
          className="h-7 gap-1.5 border-gdb-sep bg-gdb-editor/50 px-2.5 text-gdb-fgdim hover:bg-gdb-hover hover:text-gdb-fgstrong"
        >
          <IjIcon name="search" />
          <span className="hidden sm:inline">Comandos</span>
          <kbd className="rounded bg-gdb-contrast px-1 font-jetbrains text-[10px] text-gdb-muted">⌘K</kbd>
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onOpenConnections}
          title="Gestionar conexiones"
          className="h-7 gap-1.5 border-gdb-sep bg-transparent px-2.5 text-gdb-fg hover:bg-gdb-hover hover:text-gdb-fgstrong"
        >
          <IjIcon name="connect" />
          Conexiones…
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          onClick={onOpenAppearance}
          title="Apariencia: tema, densidad y paleta"
          className="border-gdb-sep bg-transparent text-gdb-fg hover:bg-gdb-hover hover:text-gdb-fgstrong"
        >
          <IjIcon name="palette" />
        </Button>
      </div>
    </header>
  );
}
