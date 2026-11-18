/**
 * Fase 70 (T1, R70) — el MODAL «Conexiones».
 *
 * Sustituye la pantalla de conexión a página completa por un modal 880×480 con la estructura de la
 * fase 29 del editor de Rust y de la maqueta aprobada
 * (`design/propuesta-ui-modal-conexiones.png`):
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Conexiones                                              ×    │
 *   ├──────────────┬───────────────────────────────────────────────┤
 *   │ ▎Local Pg    │  Nombre   [ Local Postgres                 ]  │
 *   │ ▎Acme      │  Color    ● ● ● ● ● ● ●                       │
 *   │ ▎SQL Server  │  Motor    [ PostgreSQL            ▾ ]          │
 *   │              │  Host     [ 127.0.0.1 ]  Puerto [ 5432 ]      │
 *   │              │  Usuario  [ postgres                       ]  │
 *   │ + ⧉ 🗑        │  Contraseña [ •••••••• ]  Se guarda cifrado    │
 *   │              │  Base de datos [ postgres  ] [bases… ▾]        │
 *   │              │  ☐ Solo lectura                                │
 *   ├──────────────┴───────────────────────────────────────────────┤
 *   │ [Probar conexión] Conectado · 32 ms      [Cancelar] [Guardar] │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * DECISIONES QUE SE APARTAN DE LA MAQUETA (y por qué):
 *
 *  1. **No hay desplegable de TLS.** El modelo (`ConnectionProfile`) y el servidor no tienen TLS:
 *     pintar un control que no hace nada sería mentir. Queda anotado como hueco para una fase
 *     propia (necesita `ssl` en el perfil y en los drivers de `src/server/db`).
 *  2. **«Se guarda cifrado», no «en el llavero».** La app cifra con `safeStorage` de Electron, que
 *     usa el Llavero del sistema en macOS pero no es una entrada de Llavero consultable.
 *  3. **`Guardar` guarda Y conecta la consola activa.** La maqueta trae un solo botón primario; en
 *     este producto guardar un perfil sin usarlo no sirve de nada y un segundo botón «Conectar»
 *     habría duplicado el camino. Doble clic sobre un perfil también conecta.
 *  4. **Sin badge `def`** ni botón «Limpiar filtro»: no existen (PLAN §2).
 *
 * La lógica NO es nueva: `testConnection`, `saveProfile`, `updateProfile`, `deleteProfile`,
 * `connect` y `listDatabases` son los mismos de `lib/api.ts` que usaba la pantalla completa; lo
 * que cambia es el acomodo. `bases…` solo se habilita cuando la consola activa ya está conectada
 * CON ESE perfil (listar bases necesita una sesión viva; si no, no se finge).
 */
import * as React from "react";

import { IjIcon, type IjIconName } from "@/components/ij-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";

import {
  connect as apiConnect,
  deleteProfile,
  listDatabases,
  listAwsProfiles,
  listProfiles,
  pickFile,
  saveProfile,
  testConnection,
  updateProfile,
} from "@/lib/api";
import type { ConnectionProfile, ConnectionProfileInput, Session } from "@/lib/types";
import { DEFAULT_PROFILE_COLOR, PRESET_PROFILE_COLORS, colorDeTinte } from "@/lib/profile-colors";
import { cn } from "@/lib/utils";
import { readOnlyEnforcedByDatabase, readOnlyProtectionNote } from "@/server/db/read-only-session";
import {
  PUERTO_POR_MOTOR,
  regionDeHost,
  SSH_POR_DEFECTO,
  TLS_POR_DEFECTO,
  type AuthConfig,
  type ModoTls,
  type SshConfig,
  type TlsConfig,
} from "@/shared/connection-net";
import { useAppDispatch, useActiveConsole } from "@/hooks/use-app-state";

type Motor = ConnectionProfile["type"];

const PUERTO_DEFAULT: Record<Motor, number> = { postgres: 5432, mysql: 3306, sqlserver: 1433, mongodb: 27017 };

const MOTOR_ETIQUETA: Record<Motor, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlserver: "SQL Server",
  mongodb: "MongoDB",
};

/** Color de identidad del motor, por token: nada de hex literales. */
const MOTOR_COLOR: Record<Motor, string> = {
  postgres: "text-gdb-enginepg",
  mysql: "text-gdb-enginemysql",
  sqlserver: "text-gdb-enginemssql",
  mongodb: "text-gdb-enginemongo",
};

/**
 * Icono del motor: la MARCA oficial para PostgreSQL y MySQL (`brand-icons.ts`) y el cilindro propio
 * teñido para SQL Server, que no tiene marca en Simple Icons (Microsoft la retiró). El objetivo es
 * que en la lista de conexiones y en las pestañas se reconozca el motor de un vistazo.
 */
const MOTOR_ICONO: Record<Motor, IjIconName> = {
  postgres: "postgres",
  mysql: "mysql",
  sqlserver: "database",
  mongodb: "mongodb",
};

const FORM_VACIO: ConnectionProfileInput = {
  type: "postgres",
  host: "localhost",
  port: 5432,
  user: "",
  password: "",
  database: "",
  name: "",
  color: DEFAULT_PROFILE_COLOR,
  readOnly: false,
  tls: { ...TLS_POR_DEFECTO },
  ssh: { ...SSH_POR_DEFECTO },
};

/** Etiquetas del modo de TLS, en el idioma del formulario. */
const ETIQUETA_TLS: Record<ModoTls, string> = {
  deshabilitado: "Deshabilitado",
  requerido: "Requerido (sin validar certificado)",
  "verificar-ca": "Verificar CA",
  mutuo: "Mutuo (certificado de cliente)",
};

/** Resultado de «Probar conexión», EN LÍNEA junto al botón (nunca un toast suelto). */
type Prueba = { estado: "ok"; ms: number } | { estado: "error"; mensaje: string } | null;

/**
 * Ruta a un archivo con botón para elegirla en el panel del sistema (fase 80).
 *
 * Antes solo se podía ESCRIBIR la ruta: para una CA o una clave SSH eso obliga a acordarse del
 * camino exacto y a teclearlo bien. El botón «…» es el mismo patrón que usa DataGrip al lado de un
 * campo de archivo. La ruta sigue siendo editable a mano: pegar un `~/...` y corregirlo es más
 * rápido que navegar, y el panel no resuelve `~`.
 */
function CampoArchivo({
  valor,
  onCambio,
  placeholder,
  ariaLabel,
  titulo,
  extensiones,
  className,
}: {
  valor: string;
  onCambio: (ruta: string) => void;
  placeholder?: string;
  ariaLabel: string;
  titulo: string;
  extensiones?: string[];
  className?: string;
}) {
  const [eligiendo, setEligiendo] = React.useState(false);
  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <Input
        value={valor}
        onChange={(e) => onCambio(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="h-7 min-w-0 flex-1 text-xs"
      />
      <Button
        type="button"
        size="icon-sm"
        variant="outline"
        disabled={eligiendo}
        title={titulo}
        aria-label={titulo}
        className="h-7 w-7 shrink-0 border-gdb-border bg-transparent text-gdb-fg hover:bg-gdb-hover"
        onClick={async () => {
          setEligiendo(true);
          try {
            const { path } = await pickFile(titulo, extensiones);
            // `null` = el usuario canceló: no se toca lo que ya estaba escrito.
            if (path) onCambio(path);
          } catch (err) {
            toast.error(`No se pudo abrir el panel de archivos: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            setEligiendo(false);
          }
        }}
      >
        <span aria-hidden="true" className="text-sm leading-none">
          …
        </span>
      </Button>
    </div>
  );
}

export function ConnectionsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const dispatch = useAppDispatch();
  const activeConsole = useActiveConsole();
  const session = activeConsole.session;

  const [profiles, setProfiles] = React.useState<ConnectionProfile[]>([]);
  const [seleccionId, setSeleccionId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<ConnectionProfileInput>({ ...FORM_VACIO });
  const [perfilesAws, setPerfilesAws] = React.useState<string[]>([]);
  const usaIam = !!form.auth;
  React.useEffect(() => {
    if (usaIam) listAwsProfiles().then(setPerfilesAws, () => undefined);
  }, [usaIam]);
  /** id del perfil que se está EDITANDO (null = perfil nuevo, todavía sin guardar). */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [ocupado, setOcupado] = React.useState<"probar" | "guardar" | "borrar" | null>(null);
  const [prueba, setPrueba] = React.useState<Prueba>(null);
  const [basesDisponibles, setBasesDisponibles] = React.useState<string[]>([]);

  const cargarPerfiles = React.useCallback(async () => {
    try {
      setProfiles(await listProfiles());
    } catch (err) {
      toast.error(String(err));
    }
  }, []);

  /** Rellena el formulario con un perfil guardado. La contraseña NUNCA se devuelve al cliente. */
  const editarPerfil = React.useCallback((perfil: ConnectionProfile) => {
    setEditingId(perfil.id);
    setSeleccionId(perfil.id);
    setPrueba(null);
    setBasesDisponibles([]);
    setForm({
      type: perfil.type,
      host: perfil.host,
      port: perfil.port,
      user: perfil.user,
      password: "",
      database: perfil.database,
      name: perfil.name,
      color: perfil.color || DEFAULT_PROFILE_COLOR,
      readOnly: perfil.readOnly,
      tls: perfil.tls ? { ...perfil.tls } : { ...TLS_POR_DEFECTO },
      ssh: perfil.ssh ? { ...perfil.ssh } : { ...SSH_POR_DEFECTO },
      ...(perfil.auth ? { auth: { ...perfil.auth } } : {}),
    });
  }, []);

  /** Perfil nuevo en blanco (botón `+`). */
  const nuevoPerfil = React.useCallback(() => {
    setEditingId(null);
    setSeleccionId(null);
    setPrueba(null);
    setBasesDisponibles([]);
    setForm({ ...FORM_VACIO, color: DEFAULT_PROFILE_COLOR });
  }, []);

  // Al abrir: recarga la lista y arranca con el perfil de la consola activa (o con uno nuevo).
  React.useEffect(() => {
    if (!open) return;
    let vigente = true;
    listProfiles()
      .then((lista) => {
        if (!vigente) return;
        setProfiles(lista);
        const actual = lista.find((p) => p.id === session?.profileId) ?? lista[0];
        if (actual) editarPerfil(actual);
        else nuevoPerfil();
      })
      .catch((err) => toast.error(String(err)));
    return () => {
      vigente = false;
    };
    // `session?.profileId` en las deps resetearía el formulario en cada reconexión: se lee al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editarPerfil, nuevoPerfil]);

  function cambiar<K extends keyof ConnectionProfileInput>(
    clave: K,
    valor: ConnectionProfileInput[K]
  ) {
    setPrueba(null);
    setForm((prev) => {
      const siguiente = { ...prev, [clave]: valor };
      // Al cambiar de motor se actualiza el puerto SOLO si seguía siendo el default del anterior:
      // un puerto escrito a mano no se pisa.
      if (clave === "type" && Object.values(PUERTO_DEFAULT).includes(prev.port)) {
        siguiente.port = PUERTO_DEFAULT[valor as Motor];
      }
      return siguiente;
    });
  }

  /** «Probar conexión»: mide el tiempo y deja el resultado EN LÍNEA (no un toast). */
  async function probar() {
    setOcupado("probar");
    const inicio = performance.now();
    try {
      // Con un perfil guardado, la contraseña vive cifrada: se manda el id para que el worker use
      // la suya cuando el campo va vacío (fase 17).
      const res = await testConnection(editingId ? { ...form, id: editingId } : form);
      const ms = Math.round(performance.now() - inicio);
      setPrueba(
        res.ok
          ? { estado: "ok", ms }
          : { estado: "error", mensaje: res.error || "Error de conexión" }
      );
    } catch (err) {
      setPrueba({ estado: "error", mensaje: String(err) });
    } finally {
      setOcupado(null);
    }
  }

  /** Conecta la consola con foco a un perfil por id y cierra el modal. */
  const conectar = React.useCallback(
    async (profileId: string) => {
      try {
        const nueva: Session = await apiConnect(profileId);
        dispatch({ type: "SET_SESSION", payload: { consoleId: activeConsole.id, session: nueva } });
        toast.success(`Consola conectada a ${nueva.name}`);
        onOpenChange(false);
      } catch (err) {
        toast.error(String(err));
      }
    },
    [activeConsole.id, dispatch, onOpenChange]
  );

  /**
   * `Guardar` del pie: persiste el perfil y conecta la consola activa con él.
   * Es el ÚNICO primario del modal (decisión 3 del encabezado).
   */
  async function guardarYConectar() {
    if (!form.name.trim()) {
      toast.error("El nombre del perfil es obligatorio");
      return;
    }
    setOcupado("guardar");
    try {
      const guardado = editingId
        ? await updateProfile(editingId, form)
        : await saveProfile(form);
      await cargarPerfiles();
      // R18: el color (y el nombre) nuevos llegan a TODAS las consolas de este perfil, no solo a la
      // que se reconecta abajo.
      dispatch({ type: "REFRESCAR_PERFIL", payload: { id: guardado.id, name: guardado.name, color: guardado.color } });
      setEditingId(guardado.id);
      setSeleccionId(guardado.id);
      await conectar(guardado.id);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setOcupado(null);
    }
  }

  /** Cambia un campo de TLS conservando el resto y sin tocar el formulario entero. */
  function cambiarTls(patch: Partial<TlsConfig>) {
    setPrueba(null);
    setForm((prev) => {
      const actual = prev.tls ?? TLS_POR_DEFECTO;
      const tls: TlsConfig = { ...actual, ...patch };
      // Al apagar TLS se limpian las rutas: un modo «deshabilitado» con archivos dentro es una
      // configuración que miente y que confunde al siguiente que la abra.
      if (tls.mode === "deshabilitado") return { ...prev, tls: { ...TLS_POR_DEFECTO } };
      // El certificado y la clave solo tienen sentido en modo mutuo.
      if (tls.mode !== "mutuo") {
        delete tls.certFile;
        delete tls.keyFile;
      }
      return { ...prev, tls };
    });
  }

  /** Cambia un campo del salto SSH. Apagarlo devuelve el objeto por defecto. */
  function cambiarSsh(patch: Partial<SshConfig>) {
    setPrueba(null);
    setForm((prev) => {
      const actual = prev.ssh ?? SSH_POR_DEFECTO;
      const ssh: SshConfig = { ...actual, ...patch };
      if (!ssh.enabled) return { ...prev, ssh: { ...SSH_POR_DEFECTO } };
      if (ssh.auth !== "key") delete ssh.keyFile;
      return { ...prev, ssh };
    });
  }

  /** IAM: al activarlo se propone la región del host y se sube TLS a «requerido» (RDS lo exige). */
  function cambiarAuth(patch: Partial<AuthConfig> | null) {
    setPrueba(null);
    setForm((prev) => {
      if (!patch) return { ...prev, auth: undefined };
      const auth: AuthConfig = { mode: "iam", region: regionDeHost(prev.host), ...prev.auth, ...patch };
      const tls = prev.tls && prev.tls.mode !== "deshabilitado" ? prev.tls : { ...TLS_POR_DEFECTO, mode: "requerido" as const };
      return { ...prev, auth, tls, password: "" };
    });
  }

  async function borrar() {
    if (!editingId) return;
    setOcupado("borrar");
    try {
      await deleteProfile(editingId);
      toast.success("Perfil eliminado");
      const lista = await listProfiles();
      setProfiles(lista);
      if (lista[0]) editarPerfil(lista[0]);
      else nuevoPerfil();
    } catch (err) {
      toast.error(String(err));
    } finally {
      setOcupado(null);
    }
  }

  /** Duplica el perfil seleccionado como uno NUEVO sin guardar («(copia)»). */
  function duplicar() {
    const actual = profiles.find((p) => p.id === seleccionId);
    if (!actual) return;
    setEditingId(null);
    setSeleccionId(null);
    setPrueba(null);
    setBasesDisponibles([]);
    setForm({
      type: actual.type,
      host: actual.host,
      port: actual.port,
      user: actual.user,
      password: "",
      database: actual.database,
      name: `${actual.name} (copia)`,
      color: actual.color || DEFAULT_PROFILE_COLOR,
      readOnly: actual.readOnly,
    });
  }

  /**
   * `bases…`: lista las bases de la sesión activa y rellena el campo. Solo tiene sentido cuando
   * ESA consola ya está conectada con ESE perfil: listar bases necesita una sesión viva.
   */
  const puedeListarBases =
    !!session && !!editingId && session.profileId === editingId && session.type === form.type;

  async function listarBases() {
    if (!session) return;
    try {
      const bases = await listDatabases(session.sessionId);
      if (bases.length === 0) {
        toast.info("La sesión no devolvió bases de datos");
        return;
      }
      setBasesDisponibles(bases);
      if (!form.database) cambiar("database", bases[0]);
    } catch (err) {
      toast.error(String(err));
    }
  }

  const seleccionado = profiles.find((p) => p.id === seleccionId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[480px] max-h-[85vh] w-[880px] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[880px]"
        data-testid="connections-modal"
        aria-describedby={undefined}
      >
        <DialogHeader className="shrink-0 border-b border-gdb-border px-4 py-2.5">
          <DialogTitle className="text-sm font-semibold">Conexiones</DialogTitle>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* --- Columna izquierda: perfiles (220 px) ------------------------ */}
          <div className="flex w-[220px] shrink-0 flex-col border-r border-gdb-sep bg-gdb-contrast/40">
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {profiles.length === 0 ? (
                <p className="px-2 py-3 text-xs text-gdb-fgdim">No hay perfiles guardados</p>
              ) : (
                profiles.map((perfil) => {
                  const activa = perfil.id === seleccionId;
                  return (
                    <button
                      key={perfil.id}
                      type="button"
                      onClick={() => editarPerfil(perfil)}
                      onDoubleClick={() => void conectar(perfil.id)}
                      title="Doble clic para conectar esta consola"
                      data-testid="connections-modal-fila"
                      className={[
                        "flex w-full items-center gap-2 rounded-sm py-1 pl-0 pr-2 text-left text-xs",
                        activa
                          ? "bg-gdb-listsel text-gdb-fgstrong"
                          : "text-gdb-fg hover:bg-gdb-hover",
                      ].join(" ")}
                    >
                      {/* Franja de color del perfil (4 px), como la maqueta. */}
                      <span
                        aria-hidden
                        className="h-[18px] w-1 shrink-0 rounded-r-sm"
                        style={{ backgroundColor: perfil.color || DEFAULT_PROFILE_COLOR }}
                      />
                      <IjIcon
                        name={MOTOR_ICONO[perfil.type]}
                        className={[
                          // 20 px en la lista: la marca del elefante a 16 px se lee como un borrón.
                          "shrink-0 size-5 [&>svg]:size-5",
                          // Sobre la fila seleccionada el fondo es azul oscuro y el azul de marca se
                          // pierde: ahí el icono va en el color de texto activo.
                          activa ? "text-gdb-fgstrong" : MOTOR_COLOR[perfil.type],
                        ].join(" ")}
                        label={MOTOR_ETIQUETA[perfil.type]}
                      />
                      <span className="min-w-0 flex-1 truncate">{perfil.name}</span>
                      {perfil.readOnly && <IjIcon name="locked" className="shrink-0 opacity-60" />}
                      {session?.profileId === perfil.id && (
                        <span
                          className="size-1.5 shrink-0 rounded-full bg-gdb-live"
                          title="Conectada en esta consola"
                        />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Acciones de la lista: nueva, duplicar, borrar. */}
            <div className="flex shrink-0 items-center gap-1 border-t border-gdb-border p-1">
              <Button
                size="icon-sm"
                variant="outline"
                onClick={nuevoPerfil}
                title="Nueva conexión"
                className="border-gdb-border bg-transparent text-gdb-fg hover:bg-gdb-hover"
              >
                <IjIcon name="add" />
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                onClick={duplicar}
                disabled={!seleccionado}
                title="Duplicar la conexión seleccionada"
                className="border-gdb-border bg-transparent text-gdb-fg hover:bg-gdb-hover"
              >
                <IjIcon name="copy" />
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                onClick={() => void borrar()}
                disabled={!seleccionado || ocupado === "borrar"}
                title="Borrar la conexión seleccionada"
                className="border-gdb-border bg-transparent text-gdb-fgdim hover:bg-gdb-hover hover:text-gdb-dangerfg"
              >
                <IjIcon name="delete" />
              </Button>
            </div>
          </div>

          {/* --- Formulario (etiquetas de 110 px a la izquierda) --------------- */}
          <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-gdb-chrome px-4 py-3">
            <div className="grid gap-2 text-xs">
              <Fila etiqueta="Nombre">
                <Input
                  value={form.name}
                  onChange={(e) => cambiar("name", e.target.value)}
                  placeholder="Local Postgres"
                  className="h-7 min-w-0 text-xs"
                  autoFocus
                />
              </Fila>

              <Fila etiqueta="Color">
                <div className="flex items-center gap-1.5 pt-1">
                  {PRESET_PROFILE_COLORS.map((color) => {
                    const activo =
                      (form.color || DEFAULT_PROFILE_COLOR).toLowerCase() === color.toLowerCase();
                    return (
                      <button
                        key={color}
                        type="button"
                        onClick={() => cambiar("color", color)}
                        aria-label={`Color ${color}`}
                        aria-pressed={activo}
                        className={[
                          "size-4 shrink-0 rounded-full border transition-transform",
                          activo
                            ? "scale-110 border-gdb-fgstrong ring-1 ring-gdb-fgstrong/60"
                            : "border-gdb-border hover:scale-105",
                        ].join(" ")}
                        style={{ backgroundColor: color }}
                      />
                    );
                  })}
                  {/* Color personalizado: cualquiera fuera de los presets (como en la pantalla vieja). */}
                  <label
                    className={[
                      "relative size-4 shrink-0 cursor-pointer overflow-hidden rounded-full border",
                      PRESET_PROFILE_COLORS.includes(
                        (form.color || DEFAULT_PROFILE_COLOR) as (typeof PRESET_PROFILE_COLORS)[number]
                      )
                        ? "border-gdb-border"
                        : "border-gdb-fgstrong ring-1 ring-gdb-fgstrong/60",
                    ].join(" ")}
                    title="Color personalizado"
                  >
                    <input
                      type="color"
                      value={form.color || DEFAULT_PROFILE_COLOR}
                      onChange={(e) => cambiar("color", e.target.value)}
                      className="absolute inset-0 size-full cursor-pointer opacity-0"
                      aria-label="Color personalizado"
                    />
                    <span
                      className="pointer-events-none absolute inset-0"
                      style={{ backgroundColor: form.color || DEFAULT_PROFILE_COLOR }}
                    />
                  </label>
                  {/* R18: qué hace el color, dicho donde se elige (el azul de fábrica no tiñe). */}
                  <span className="ml-1 text-[10.5px] text-gdb-fgdim" data-testid="color-ayuda">
                    {colorDeTinte(form.color) ? "Tiñe el explorador" : "Sin tinte (azul de fábrica)"}
                  </span>
                </div>
              </Fila>

              <Fila etiqueta="Motor">
                <Select
                  value={form.type}
                  onValueChange={(v) => {
                    const motor = v as Motor;
                    // El puerto sigue al motor mientras el usuario no lo haya cambiado a mano: al
                    // elegir MongoDB, 5432 deja de tener sentido y la conexión fallaría por puerto.
                    const puertoViejo = PUERTO_POR_MOTOR[form.type];
                    const puerto = form.port === puertoViejo ? PUERTO_POR_MOTOR[motor] : form.port;
                    setPrueba(null);
                    setForm((prev) => ({ ...prev, type: motor, port: puerto }));
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    aria-label="Motor de base de datos"
                    className="h-7 w-[240px] gap-2 border-gdb-border bg-gdb-field px-2 text-xs text-gdb-fgstrong"
                  >
                    <IjIcon name={MOTOR_ICONO[form.type]} className={MOTOR_COLOR[form.type]} />
                    <SelectValue>{MOTOR_ETIQUETA[form.type]}</SelectValue>
                    {/* El chevron ya lo pinta el SelectTrigger. */}
                  </SelectTrigger>
                  <SelectContent className="border-gdb-border bg-popover p-1 text-gdb-fg">
                    {(Object.keys(MOTOR_ETIQUETA) as Motor[]).map((motor) => (
                      <SelectItem key={motor} value={motor} className="text-xs">
                        <span className="flex items-center gap-2">
                          <IjIcon name={MOTOR_ICONO[motor]} className={MOTOR_COLOR[motor]} />
                          {MOTOR_ETIQUETA[motor]}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Fila>

              <div className="grid grid-cols-[110px_minmax(0,1fr)_58px_104px] items-start gap-2">
                <Etiqueta>Host</Etiqueta>
                <Input
                  value={form.host}
                  onChange={(e) => {
                    cambiar("host", e.target.value);
                    if (form.auth && !form.auth.region) cambiarAuth({ region: regionDeHost(e.target.value) });
                  }}
                  placeholder="127.0.0.1"
                  className="h-7 min-w-0 text-xs"
                />
                <Etiqueta>Puerto</Etiqueta>
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => cambiar("port", Number(e.target.value))}
                  placeholder={String(PUERTO_DEFAULT[form.type])}
                  className="h-7 w-full min-w-0 text-xs"
                />
              </div>

              <Fila etiqueta="Usuario">
                <Input
                  value={form.user}
                  onChange={(e) => cambiar("user", e.target.value)}
                  placeholder={form.type === "sqlserver" ? "sa" : "postgres"}
                  className="h-7 min-w-0 text-xs"
                />
              </Fila>

              {!form.auth && (
              <Fila etiqueta="Contraseña">
                <div className="grid gap-1">
                  <Input
                    type="password"
                    value={form.password}
                    onChange={(e) => cambiar("password", e.target.value)}
                    placeholder={
                      editingId && profiles.find((p) => p.id === editingId)?.hasPassword !== false
                        ? "Dejar en blanco para mantener la actual"
                        : "••••••••"
                    }
                    className="h-7 min-w-0 text-xs"
                  />
                  {/*
                    Fase 17 (R6, verificado 2026-10-20): la contraseña va cifrada con `safeStorage`
                    en `data/secrets.json` bajo `db.<id>`; `connections.json` NO la contiene. La nota
                    puede decir «cifrado» porque es lo que pasa, no lo que se desea.
                  */}
                  <span className="text-[10px] text-gdb-fgdim">Se guarda cifrado</span>
                </div>
              </Fila>
              )}
              {(form.type === "postgres" || form.type === "mysql") && (
                <>
                  <Fila etiqueta="IAM (AWS)">
                    <label className="flex items-center gap-2 pt-1 text-xs text-gdb-fg">
                      <input
                        type="checkbox"
                        checked={!!form.auth}
                        onChange={(e) => cambiarAuth(e.target.checked ? {} : null)}
                        className="size-3.5 accent-primary"
                        aria-label="Autenticar con IAM"
                      />
                      Token de RDS/Aurora en lugar de contraseña
                    </label>
                  </Fila>
                  {form.auth && (
                    <>
                      <Fila etiqueta="Región">
                        <Input
                          value={form.auth.region}
                          onChange={(e) => cambiarAuth({ region: e.target.value })}
                          placeholder="us-east-2"
                          aria-label="Región de AWS"
                          className="h-7 text-xs"
                        />
                      </Fila>
                      <Fila etiqueta="Perfil AWS">
                        <Input
                          list="aws-perfiles"
                          value={form.auth.awsProfile ?? ""}
                          onChange={(e) => cambiarAuth({ awsProfile: e.target.value })}
                          placeholder="vacío = credenciales por defecto"
                          aria-label="Perfil de AWS"
                          className="h-7 text-xs"
                        />
                        <datalist id="aws-perfiles">
                          {perfilesAws.map((nombre) => (
                            <option key={nombre} value={nombre} />
                          ))}
                        </datalist>
                      </Fila>
                    </>
                  )}
                </>
              )}

              <Fila etiqueta="Base de datos">
                <div className="flex items-center gap-1">
                  <Input
                    value={form.database}
                    onChange={(e) => cambiar("database", e.target.value)}
                    placeholder="postgres"
                    className="h-7 min-w-0 text-xs"
                  />
                  {basesDisponibles.length > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            size="sm"
                            variant="outline"
                            title="Elegir entre las bases de la sesión activa"
                            className="h-7 shrink-0 gap-1 border-gdb-border bg-transparent px-1.5 text-xs text-gdb-fg hover:bg-gdb-hover"
                          >
                            bases…
                            <IjIcon name="chevronDown" className="opacity-60" />
                          </Button>
                        }
                      />
                      <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto">
                        {basesDisponibles.map((db) => (
                          <DropdownMenuItem key={db} onClick={() => cambiar("database", db)}>
                            <IjIcon name="database" />
                            {db}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void listarBases()}
                      disabled={!puedeListarBases}
                      title={
                        puedeListarBases
                          ? "Listar las bases de la sesión activa"
                          : "Conecta esta consola con el perfil para listar sus bases"
                      }
                      className="h-7 shrink-0 gap-1 border-gdb-border bg-transparent px-1.5 text-xs text-gdb-fgdim hover:bg-gdb-hover hover:text-gdb-fg"
                    >
                      bases…
                      <IjIcon name="chevronDown" className="opacity-60" />
                    </Button>
                  )}
                </div>
              </Fila>

              <Fila etiqueta="Solo lectura">
                <label className="flex items-center gap-2 pt-1 text-xs text-gdb-fg">
                  <input
                    type="checkbox"
                    checked={form.readOnly ?? false}
                    onChange={(e) => cambiar("readOnly", e.target.checked)}
                    className="size-3.5 accent-primary"
                  />
                  <IjIcon name="locked" />
                  Bloquea INSERT/UPDATE/DELETE/DDL
                </label>
              </Fila>

              {/* --- Fase 80: TLS con archivos ------------------------------------ */}
              <Fila etiqueta="TLS">
                <div className="flex items-center gap-2">
                  <Select
                    value={form.tls?.mode ?? "deshabilitado"}
                    onValueChange={(v) => cambiarTls({ mode: v as ModoTls })}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="Modo de TLS"
                      className="h-7 w-[240px] border-gdb-border bg-gdb-field text-xs text-gdb-fgstrong"
                    >
                      {/* Se pinta a mano: el `SelectValue` de base-ui no resuelve hijos función. */}
                      <span className="truncate">{ETIQUETA_TLS[form.tls?.mode ?? "deshabilitado"]}</span>
                    </SelectTrigger>
                    <SelectContent className="border-gdb-border bg-popover p-1 text-gdb-fg">
                      {(Object.keys(ETIQUETA_TLS) as ModoTls[]).map((modo) => (
                        <SelectItem key={modo} value={modo} className="text-xs">
                          {ETIQUETA_TLS[modo]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </Fila>
              {form.tls && form.tls.mode !== "deshabilitado" && (
                <>
                  <Fila etiqueta="CA">
                    <div className="flex flex-col gap-1">
                      <CampoArchivo
                        valor={form.tls.caFile ?? ""}
                        onCambio={(ruta) => cambiarTls({ caFile: ruta })}
                        placeholder="/ruta/ca.pem"
                        ariaLabel="Archivo de CA"
                        titulo="Elegir el certificado de CA"
                        extensiones={["pem", "crt", "cer"]}
                      />
                      {!form.tls.caFile && (form.tls.mode === "verificar-ca" || form.tls.mode === "mutuo") && (
                        <span className="text-[11px] text-gdb-warnfg">Hace falta para validar el certificado</span>
                      )}
                    </div>
                  </Fila>
                  {form.tls.mode === "mutuo" && (
                    <>
                      <Fila etiqueta="Certificado">
                        <CampoArchivo
                          valor={form.tls.certFile ?? ""}
                          onCambio={(ruta) => cambiarTls({ certFile: ruta })}
                          placeholder="/ruta/cliente.pem"
                          ariaLabel="Certificado de cliente"
                          titulo="Elegir el certificado de cliente"
                          extensiones={["pem", "crt", "cer"]}
                        />
                      </Fila>
                      <Fila etiqueta="Clave">
                        <CampoArchivo
                          valor={form.tls.keyFile ?? ""}
                          onCambio={(ruta) => cambiarTls({ keyFile: ruta })}
                          placeholder="/ruta/cliente-key.pem"
                          ariaLabel="Clave privada del cliente"
                          titulo="Elegir la clave privada del cliente"
                          extensiones={["pem", "key"]}
                        />
                      </Fila>
                    </>
                  )}
                  <Fila etiqueta="Nombre TLS">
                    <Input
                      value={form.tls.serverName ?? ""}
                      onChange={(e) => cambiarTls({ serverName: e.target.value })}
                      placeholder="host del certificado (opcional)"
                      aria-label="Nombre del certificado"
                      className="h-7 text-xs"
                    />
                  </Fila>
                </>
              )}

              {/* --- Fase 80: túnel SSH ------------------------------------------- */}
              <Fila etiqueta="Túnel SSH">
                <label className="flex items-center gap-2 pt-1 text-xs text-gdb-fg">
                  <input
                    type="checkbox"
                    checked={form.ssh?.enabled ?? false}
                    onChange={(e) => cambiarSsh({ enabled: e.target.checked })}
                    className="size-3.5 accent-primary"
                    aria-label="Usar túnel SSH"
                  />
                  Conectar a través de un salto SSH
                </label>
              </Fila>
              {form.ssh?.enabled && (
                <>
                  <Fila etiqueta="Salto">
                    <div className="grid grid-cols-[1fr_90px] gap-2">
                      <Input
                        value={form.ssh.host}
                        onChange={(e) => cambiarSsh({ host: e.target.value })}
                        placeholder="jump.example.com"
                        aria-label="Host del salto SSH"
                        className="h-7 text-xs"
                      />
                      <Input
                        type="number"
                        value={form.ssh.port}
                        onChange={(e) => cambiarSsh({ port: Number(e.target.value) })}
                        placeholder="22"
                        aria-label="Puerto del salto SSH"
                        className="h-7 text-xs"
                      />
                    </div>
                  </Fila>
                  <Fila etiqueta="Usuario SSH">
                    <Input
                      value={form.ssh.user}
                      onChange={(e) => cambiarSsh({ user: e.target.value })}
                      placeholder="tu usuario en el salto"
                      aria-label="Usuario del salto SSH"
                      className="h-7 text-xs"
                    />
                  </Fila>
                  <Fila etiqueta="Auth SSH">
                    <Select
                      value={form.ssh.auth}
                      onValueChange={(v) => cambiarSsh({ auth: v as SshConfig["auth"] })}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label="Autenticación del salto SSH"
                        className="h-7 w-[240px] border-gdb-border bg-gdb-field text-xs text-gdb-fgstrong"
                      >
                        <span>{form.ssh.auth === "key" ? "Clave privada" : "Contraseña"}</span>
                      </SelectTrigger>
                      <SelectContent className="border-gdb-border bg-popover p-1 text-gdb-fg">
                        <SelectItem value="password" className="text-xs">
                          Contraseña
                        </SelectItem>
                        <SelectItem value="key" className="text-xs">
                          Clave privada
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Fila>
                  {form.ssh.auth === "key" ? (
                    <>
                      <Fila etiqueta="Clave SSH">
                        <CampoArchivo
                          valor={form.ssh.keyFile ?? ""}
                          onCambio={(ruta) => cambiarSsh({ keyFile: ruta })}
                          placeholder="~/.ssh/id_ed25519"
                          ariaLabel="Clave privada del salto SSH"
                          titulo="Elegir la clave privada del salto SSH"
                        />
                      </Fila>
                      <Fila etiqueta="Frase de paso">
                        <Input
                          type="password"
                          value={form.sshPassphrase ?? ""}
                          onChange={(e) => cambiar("sshPassphrase", e.target.value)}
                          placeholder={form.ssh.hasPassphrase ? "Guardada — escribe para cambiarla" : "Opcional"}
                          aria-label="Frase de paso de la clave SSH"
                          className="h-7 text-xs"
                        />
                      </Fila>
                    </>
                  ) : (
                    <Fila etiqueta="Contraseña SSH">
                      <Input
                        type="password"
                        value={form.sshPassword ?? ""}
                        onChange={(e) => cambiar("sshPassword", e.target.value)}
                        placeholder={form.ssh.hasPassword ? "Guardada — escribe para cambiarla" : ""}
                        aria-label="Contraseña del salto SSH"
                        className="h-7 text-xs"
                      />
                    </Fila>
                  )}
                </>
              )}

              {/* R53: SQL Server no puede hacer cumplir solo-lectura en la sesión. */}
              {form.readOnly && !readOnlyEnforcedByDatabase(form.type) && (
                <p
                  role="note"
                  className="ml-[118px] flex items-start gap-2 rounded-md border border-gdb-warn/30 bg-gdb-warn/10 p-2 text-[11px] text-gdb-warnfg"
                >
                  <IjIcon name="warning" className="mt-0.5 shrink-0" />
                  {readOnlyProtectionNote(form.type)}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* --- Pie: Probar (resultado inline) · Cancelar / Guardar -------------- */}
        <div className="flex shrink-0 items-center gap-2 border-t border-gdb-border px-4 py-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void probar()}
            disabled={ocupado !== null}
            className="h-7 gap-1.5 border-gdb-border bg-transparent text-gdb-fg hover:bg-gdb-hover"
          >
            <IjIcon name="connect" />
            {ocupado === "probar" ? "Probando…" : "Probar conexión"}
          </Button>
          {prueba?.estado === "ok" && (
            <span className="flex items-center gap-1.5 text-xs text-gdb-okfg" data-testid="prueba-ok">
              <span className="size-1.5 rounded-full bg-gdb-live" />
              Conectado · {prueba.ms} ms
            </span>
          )}
          {prueba?.estado === "error" && (
            <span
              className="max-w-[360px] truncate text-xs text-gdb-dangerfg"
              title={prueba.mensaje}
              data-testid="prueba-error"
            >
              {prueba.mensaje}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="h-7 border-gdb-border bg-transparent text-gdb-fg hover:bg-gdb-hover"
            >
              Cancelar
            </Button>
            <Button
              size="sm"
              onClick={() => void guardarYConectar()}
              disabled={ocupado !== null}
              title="Guarda el perfil y conecta la consola activa"
              className="h-7 shrink-0 whitespace-nowrap bg-primary px-3 text-primary-foreground hover:bg-primary/90"
            >
              {ocupado === "guardar" ? "Guardando…" : "Guardar"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Etiqueta de una fila del formulario (110 px en la columna izquierda de la rejilla). */
function Etiqueta({ children }: { children: React.ReactNode }) {
  return <Label className="pt-1.5 text-xs font-normal text-gdb-fgdim">{children}</Label>;
}

/** Una fila del formulario: etiqueta fija de 110 px y el campo a la derecha. */
function Fila({ etiqueta, children }: { etiqueta: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-start gap-2">
      <Etiqueta>{etiqueta}</Etiqueta>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
