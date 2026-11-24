import * as React from "react";
import { IjIcon } from "@/components/ij-icon";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useAppState,
  useAppDispatch,
  useActiveConsole,
} from "@/hooks/use-app-state";
import {
  connect as apiConnect,
  disconnect as apiDisconnect,
  listProfiles,
} from "@/lib/api";
import { switchDatabaseWithConsoleReconnect } from "@/lib/session-reconnect-client";
import type { ConnectionProfile, Session } from "@/lib/types";
import { ConnectionScreen } from "./connection-screen";
import { DEFAULT_PROFILE_COLOR } from "@/lib/profile-colors";

/**
 * Barra de conexión por consola (multi-conexión estilo DataGrip).
 *
 * Vive a la altura de la consola SQL con foco (no en el header global): con
 * multi-conexión la DB/perfil dependen de la consola activa, no de una
 * conexión global. Tiene dos estados:
 *
 *  - Consola SIN sesión: botón "Conectar…" que despliega los perfiles
 *    guardados para conectar esta consola concreta, más la opción de abrir el
 *    formulario completo de nueva conexión en un diálogo.
 *  - Consola CON sesión: punto de color + nombre del perfil + selector de
 *    database (scoped a esta consola) + menú para "Cambiar conexión" o
 *    "Desconectar esta consola".
 *
 * Todas las acciones apuntan explícitamente al `consoleId` de la consola con
 * foco, de modo que conectar/cambiar/desconectar aquí nunca afecta a otras
 * consolas ni a sus conexiones.
 */
export function ConsoleConnectionBar() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const activeConsole = useActiveConsole();
  const session = activeConsole.session;
  const consoleId = activeConsole.id;

  const [profiles, setProfiles] = React.useState<ConnectionProfile[]>([]);
  const [connecting, setConnecting] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  const loadProfiles = React.useCallback(async () => {
    try {
      const list = await listProfiles();
      setProfiles(list);
    } catch (err) {
      toast.error(String(err));
    }
  }, []);

  React.useEffect(() => {
    // Carga inicial de perfiles guardados para el menú de conexión. El setState
    // ocurre dentro de la promesa (no sincrónicamente), así que es seguro.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProfiles();
  }, [loadProfiles]);

  // Conecta ESTA consola a un perfil guardado. La carga de schema/databases se
  // dispara sola en app-shell al detectar la nueva sesión de la consola activa.
  async function connectProfile(profile: ConnectionProfile) {
    setConnecting(true);
    try {
      const newSession = await apiConnect(profile.id);
      dispatch({
        type: "SET_SESSION",
        payload: { consoleId, session: newSession },
      });
      toast.success(`Consola conectada a ${newSession.name}`);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setConnecting(false);
    }
  }

  /*
    Fase 6 (R5, T3): «File ▸ New Connection…» del menú nativo abre este mismo diálogo. El estado
    que lo controla es un `useState` local, así que se publica un listener de `window` en vez de
    subir el estado al reducer: el diálogo sigue siendo asunto de este componente.
  */
  React.useEffect(() => {
    const abrir = () => setDialogOpen(true);
    window.addEventListener("gestordb:new-connection", abrir);
    return () => window.removeEventListener("gestordb:new-connection", abrir);
  }, []);

  // Callback del formulario completo (nueva conexión) dentro del diálogo.
  function handleConnectedFromDialog(newSession: Session) {
    dispatch({
      type: "SET_SESSION",
      payload: { consoleId, session: newSession },
    });
    setDialogOpen(false);
  }

  async function handleSwitchDatabase(database: string) {
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

  // Desconecta SOLO esta consola: cierra la sesión en el server y la limpia del
  // estado local. Las demás consolas siguen conectadas.
  async function handleDisconnectConsole() {
    if (session) {
      await apiDisconnect(session.sessionId).catch(() => undefined);
    }
    dispatch({ type: "DISCONNECT_CONSOLE", payload: { consoleId } });
    toast.info("Consola desconectada");
  }

  // ---- Estado SIN conexión --------------------------------------------------
  if (!session) {
    return (
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                variant="outline"
                disabled={connecting}
                title="Conectar esta consola a una base de datos"
                className="border-gdb-border bg-transparent text-gdb-fg hover:bg-gdb-hover hover:text-gdb-fgstrong"
              >
                <IjIcon name="connect" />
                {connecting ? "Conectando…" : "Conectar…"}
                <IjIcon name="chevronDown" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Perfiles guardados
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
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: profile.color || DEFAULT_PROFILE_COLOR }}
                    />
                    <span className="flex-1 truncate">{profile.name}</span>
                    {profile.readOnly && (
                      <IjIcon name="locked" className="shrink-0" />
                    )}
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setDialogOpen(true)} className="gap-2">
              <IjIcon name="add" />
              Nueva conexión…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="text-[11px] text-muted-foreground">Sin conexión</span>

        <ConnectionDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onConnected={handleConnectedFromDialog}
        />
      </div>
    );
  }

  // ---- Estado CON conexión --------------------------------------------------
  return (
    <div className="flex items-center gap-2">
      {/* Perfil + punto de color de la conexión de esta consola. */}
      <span className="flex items-center gap-1.5">
        <span
          className="size-2.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/10"
          style={{ backgroundColor: session.color || DEFAULT_PROFILE_COLOR }}
        />
        <span className="max-w-[160px] truncate text-xs font-medium text-foreground">
          {session.name}
        </span>
        {session.readOnly && (
          <IjIcon name="locked" label="Solo lectura" className="shrink-0" />
        )}
      </span>

      {/* Selector de database (scoped a esta consola). */}
      <Select
        value={session.database || ""}
        onValueChange={(v) => v && void handleSwitchDatabase(v)}
      >
        <SelectTrigger
          size="sm"
          className="h-7 min-w-[120px] max-w-[220px] gap-2 rounded-md border-gdb-border bg-gdb-field px-2.5 py-1 text-xs text-gdb-fgstrong hover:bg-gdb-hover focus-visible:border-primary/50 focus-visible:ring-0"
        >
          <SelectValue placeholder="Database">
            {(value: string) => (
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <IjIcon name="database" className="shrink-0" />
                <span className="truncate">{value || session.database}</span>
              </span>
            )}
          </SelectValue>
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

      {/* Menú: cambiar conexión / desconectar esta consola. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="outline"
              title="Opciones de conexión de esta consola"
              className="border-gdb-border bg-transparent text-gdb-fgdim hover:bg-gdb-hover hover:text-gdb-fgstrong"
            >
              <IjIcon name="connect" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Cambiar conexión
            </DropdownMenuLabel>
            {profiles.map((profile) => (
              <DropdownMenuItem
                key={profile.id}
                onClick={() => void connectProfile(profile)}
                className="gap-2"
                disabled={connecting}
              >
                <span
                  className="size-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: profile.color || DEFAULT_PROFILE_COLOR }}
                />
                <span className="flex-1 truncate">{profile.name}</span>
                {profile.id === session.profileId && (
                  <span className="text-[10px] text-muted-foreground">actual</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuItem onClick={() => setDialogOpen(true)} className="gap-2">
            <IjIcon name="add" />
            Nueva conexión…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => void handleDisconnectConsole()}
            className="gap-2"
          >
            <IjIcon name="disconnect" />
            Desconectar esta consola
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConnectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onConnected={handleConnectedFromDialog}
      />
    </div>
  );
}

/**
 * Diálogo que envuelve el formulario completo de conexión (ConnectionScreen)
 * para "nueva conexión / cambiar conexión" desde la barra de la consola, sin
 * bloquear toda la app como sí hace la pantalla de arranque.
 */
function ConnectionDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (session: Session) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[min(96vw,56rem)] overflow-y-auto p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Conectar esta consola</DialogTitle>
        </DialogHeader>
        {/* Reutilizamos el formulario/lista de perfiles existente. Su callback
            onConnected ya nos entrega la Session lista para asignar a la consola. */}
        <ConnectionScreen onConnected={onConnected} />
      </DialogContent>
    </Dialog>
  );
}
