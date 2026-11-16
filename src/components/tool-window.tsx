/**
 * Tool windows: dock, overlay de las No fijadas y su menú de opciones (fase 9, T2-T3; R12).
 *
 * - `ToolWindowDock`: una zona del layout (izquierda, abajo, derecha) que pinta su tool window FIJADA activa.
 *   Desde R97 hay UNA por dock (abrir otra del mismo dock oculta la anterior, como DataGrip) y no hay tira de
 *   pestañas: el conmutador es el botón de la barra y el menú de opciones, su clic derecho.
 * - `ToolWindowOverlay`: la tool window No fijada abierta. Se pinta ENCIMA del contenido, pegada al borde de su
 *   dock, sin mover el layout (el editor no salta), y se oculta al perder foco: clic fuera, foco a otro control
 *   (p. ej. el editor) o ⎋.
 * - `ToolWindowMenu*`: el menú «⋮» de IntelliJ reducido al alcance de D2 — Modo de vista (Fijada / No fijada),
 *   «Mover a ▸ Izquierda/Abajo/Derecha» y Ocultar. El mismo contenido sirve para el menú del botón ⋮ y para el
 *   clic derecho (en base-ui, las piezas del ContextMenu SON las del Menu, así que los items se comparten).
 */
import * as React from "react";
import { IjIcon } from "@/components/ij-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DOCKS,
  DOCK_LABELS,
  TOOL_WINDOWS,
  resolveActive,
  type Dock,
  type ToolWindowId,
  type ViewMode,
} from "@/shell/layout";
import {
  hideToolWindow,
  moveToolWindow,
  setToolWindowMode,
  useLayoutState,
} from "@/shell/layout-store";
import { cn } from "@/lib/utils";

const metaOf = (id: ToolWindowId) => TOOL_WINDOWS.find((t) => t.id === id)!;

/** Contenido del menú de opciones de una tool window (sirve para el ⋮ y para el clic derecho). */
function ToolWindowMenuItems({ id }: { id: ToolWindowId }) {
  const layout = useLayoutState();
  // `closeOnClick` en los RadioItem: en base-ui NO cierran el menú por defecto (sí los Item normales). Sin él el
  // menú se quedaba abierto tras elegir; el clic siguiente lo cerraba y base-ui devolvía el foco a su disparador
  // (el botón de la barra), así que el teclado no llegaba al editor y un segundo menú actuaba sobre el primero
  // (medido en la verificación de T3: «Mover a» movió Resultados en lugar de Historial).
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Modo de vista</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={layout.modes[id]}
          onValueChange={(v) => setToolWindowMode(id, v as ViewMode)}
        >
          <DropdownMenuRadioItem value="pinned" closeOnClick data-tool-window-menu-item="pinned">
            Fijada
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="unpinned" closeOnClick data-tool-window-menu-item="unpinned">
            No fijada
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-tool-window-menu-item="move">Mover a</DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup value={layout.docks[id]} onValueChange={(v) => moveToolWindow(id, v as Dock)}>
            {DOCKS.map((d) => (
              <DropdownMenuRadioItem key={d} value={d} closeOnClick data-tool-window-menu-item={`move-${d}`}>
                {DOCK_LABELS[d]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem data-tool-window-menu-item="hide" onClick={() => hideToolWindow(id)}>
        <IjIcon name="hide" />
        Ocultar
      </DropdownMenuItem>
    </>
  );
}

/** Botón «⋮» de la cabecera (tira de pestañas del dock o cabecera del overlay). */
function ToolWindowOptionsButton({ id }: { id: ToolWindowId }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-tool-window-options={id}
            title={`Opciones de ${metaOf(id).label}`}
            className="flex w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-gdb-hover hover:text-foreground"
          />
        }
      >
        <IjIcon name="moreHorizontal" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <ToolWindowMenuItems id={id} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Clic derecho sobre un disparador (botón de la barra, pestaña del dock) → el mismo menú de opciones. */
export function ToolWindowContextMenu({ id, children }: { id: ToolWindowId; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ToolWindowMenuItems id={id} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Botón «Ocultar» (−) de las cabeceras: el mismo gesto que el ítem del menú. */
function HideButton({ id }: { id: ToolWindowId }) {
  return (
    <button
      type="button"
      data-tool-window-hide={id}
      onClick={() => hideToolWindow(id)}
      title={`Ocultar ${metaOf(id).label}`}
      className="flex w-8 items-center justify-center text-muted-foreground transition-colors hover:bg-gdb-hover hover:text-foreground"
    >
      <IjIcon name="hide" />
    </button>
  );
}

export function ToolWindowDock({
  dock,
  children,
}: {
  dock: Dock;
  /** Contenido de una tool window (el llamador decide qué componente montar para cada id). */
  children: (id: ToolWindowId) => React.ReactNode;
}) {
  const layout = useLayoutState();
  const active = resolveActive(layout, dock);

  if (!active) return null;

  /*
    R97 (pedido del usuario, 2026-10-22): el dock YA NO dibuja la tira de pestañas «Explorador | Guardadas»
    con su ⋮ y su «—»: repetía los botones de la barra de tool windows. Un dock muestra una sola tool window
    (`show` oculta a las demás de su dock, como cada lado de DataGrip), el botón de la barra es el conmutador
    (clic en el activo = ocultar) y su clic derecho abre el mismo menú de opciones que tenía el ⋮.
  */
  return (
    <div
      data-tool-window-dock={dock}
      data-tool-window-activa={active}
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-sidebar"
    >
      <div className="min-h-0 flex-1 overflow-hidden">{children(active)}</div>
    </div>
  );
}

/**
 * ¿El objetivo de un evento cuenta como «fuera» del overlay? No cuentan: los propios conmutadores de tool
 * windows (barra y header; si no, el clic que debería cerrarla la cerraría aquí y el toggle la reabriría) ni las
 * capas flotantes que la propia tool window abre en un portal fuera de su caja (menús, diálogos, listas,
 * toasts): elegir un ítem del menú ⋮ no debe cerrarla antes de aplicar la acción.
 */
function countsAsOutside(target: EventTarget | null, box: HTMLElement | null, id: ToolWindowId): boolean {
  if (!(target instanceof Element) || !box) return false;
  if (box.contains(target)) return false;
  // El conmutador de OTRA tool window sí cuenta como fuera: activar otra es que esta pierda el foco.
  const toggle = target.closest("[data-tool-window-toggle]");
  if (toggle) return toggle.getAttribute("data-tool-window-toggle") !== id;
  return !target.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [data-sonner-toaster]');
}

/**
 * Overlay de la tool window No fijada abierta (como mucho una: abrir otra cierra la anterior, ver `show`).
 * Se coloca dentro del contenedor `relative` del área de docks; sus medidas son fijas a propósito (no el ancho
 * del dock fijado): flotar encima no debe depender de un panel que puede estar colapsado a 0.
 */
export function ToolWindowOverlay({
  id,
  children,
}: {
  id: ToolWindowId;
  children: (id: ToolWindowId) => React.ReactNode;
}) {
  const layout = useLayoutState();
  const dock = layout.docks[id];
  const meta = metaOf(id);
  const boxRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Captura: el overlay se entera antes que nadie de un clic fuera (CodeMirror, el grid y algunos botones
    // paran la propagación del pointerdown en fase de burbuja).
    const onPointerDown = (e: PointerEvent) => {
      if (countsAsOutside(e.target, boxRef.current, id)) hideToolWindow(id);
    };
    // Foco a otro control sin ratón (Tab, un atajo que enfoca el editor): también es perder foco.
    const onFocusIn = (e: FocusEvent) => {
      if (countsAsOutside(e.target, boxRef.current, id)) hideToolWindow(id);
    };
    // ⎋ en burbuja y solo si nadie lo consumió: CodeMirror lo usa para cerrar el autocompletado (y hace
    // preventDefault), y un menú o diálogo abierto se cierra primero a sí mismo.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      hideToolWindow(id);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [id]);

  return (
    <div
      ref={boxRef}
      data-tool-window-overlay={id}
      data-dock={dock}
      className={cn(
        // Sombra DIRECCIONAL hacia el contenido que tapa: la `shadow-2xl` de Tailwind (0 25px 50px -12px) cae hacia
        // abajo y en un panel pegado al borde izquierdo apenas asomaba por el lado (medido en la verificación de T5:
        // en New UI Light no se distinguía de un panel acoplado). Negro con alfa, como las sombras de Tailwind: no es
        // un color de tema (el test de colores fijos solo prohíbe hex y clases de paleta).
        "absolute z-40 flex flex-col overflow-hidden bg-card",
        dock === "left" && "inset-y-0 left-0 w-[min(380px,45%)] border-r border-gdb-sep shadow-[8px_0_24px_-4px_rgb(0_0_0/0.35)]",
        dock === "right" && "inset-y-0 right-0 w-[min(380px,45%)] border-l border-gdb-sep shadow-[-8px_0_24px_-4px_rgb(0_0_0/0.35)]",
        dock === "bottom" && "inset-x-0 bottom-0 h-[45%] border-t border-gdb-sep shadow-[0_-8px_24px_-4px_rgb(0_0_0/0.35)]"
      )}
    >
      <ToolWindowContextMenu id={id}>
        <div className="flex h-8 shrink-0 items-stretch border-b border-gdb-sep bg-gdb-twactive">
          <div className="flex items-center gap-1.5 px-2.5 text-xs text-gdb-fgstrong">
            <IjIcon name={meta.icon} />
            <span className="truncate">{meta.label}</span>
          </div>
          <div className="flex-1" />
          <ToolWindowOptionsButton id={id} />
          <HideButton id={id} />
        </div>
      </ToolWindowContextMenu>
      <div className="min-h-0 flex-1">{children(id)}</div>
    </div>
  );
}
