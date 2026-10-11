import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getSeatLayouts, createSeatLayout, deleteSeatLayout } from "@/api/trips";
import type { SeatLayoutRead } from "@/types/trips";

const HEAD_CLASS = "bg-[#E8EBFA] text-xs font-medium uppercase tracking-wide text-[#4A4A6A]";

export default function SeatLayoutsSection() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [totalSemiCama, setTotalSemiCama] = useState("");
  const [totalCama, setTotalCama] = useState("");
  const [saving, setSaving] = useState(false);
  const [layoutToDelete, setLayoutToDelete] = useState<SeatLayoutRead | null>(null);

  const layoutsQuery = useQuery({
    queryKey: ["admin", "seat-layouts"],
    queryFn: getSeatLayouts,
  });
  const layouts = layoutsQuery.data ?? [];

  const semiCama = Number(totalSemiCama);
  const cama = Number(totalCama);
  // El backend exige al menos un asiento Cama (ck_seat_layouts_total_cama).
  const valid =
    name.trim() !== "" &&
    totalSemiCama !== "" &&
    Number.isInteger(semiCama) && semiCama >= 0 && semiCama <= 100 &&
    Number.isInteger(cama) && cama >= 1 && cama <= 100;

  function resetForm() {
    setName("");
    setTotalSemiCama("");
    setTotalCama("");
  }

  async function handleCreateSubmit() {
    setSaving(true);
    try {
      await createSeatLayout({ name: name.trim(), total_cama: cama, total_semi_cama: semiCama });
      toast.success("Layout creado");
      queryClient.invalidateQueries({ queryKey: ["admin", "seat-layouts"] });
      setCreateOpen(false);
      resetForm();
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        toast.error("Ya existe un layout con ese nombre.");
      } else {
        toast.error("Error al crear el layout.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDelete() {
    if (!layoutToDelete) return;
    try {
      await deleteSeatLayout(layoutToDelete.id);
      toast.success("Layout eliminado");
      queryClient.invalidateQueries({ queryKey: ["admin", "seat-layouts"] });
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        toast.error("No se puede eliminar: el layout tiene viajes programados.");
      } else {
        toast.error("Error al eliminar el layout.");
      }
    } finally {
      setLayoutToDelete(null);
    }
  }

  return (
    <div className="mt-10">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-neutral-600">
          Layouts
        </h2>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          Agregar layout
        </Button>
      </div>

      <div className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className={HEAD_CLASS}>Nombre</TableHead>
              <TableHead className={HEAD_CLASS}>Semi Cama</TableHead>
              <TableHead className={HEAD_CLASS}>Cama</TableHead>
              <TableHead className={HEAD_CLASS}>Acciones</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {layoutsQuery.isLoading && (
              <TableRow>
                <TableCell className="py-3" colSpan={4}>
                  <Skeleton className="h-6 w-full" />
                </TableCell>
              </TableRow>
            )}

            {!layoutsQuery.isLoading && layouts.length === 0 && (
              <TableRow>
                <TableCell className="py-3" colSpan={4}>
                  <p className="text-center text-sm text-neutral-600">
                    No hay layouts registrados.
                  </p>
                </TableCell>
              </TableRow>
            )}

            {!layoutsQuery.isLoading &&
              layouts.map((layout) => (
                <TableRow key={layout.id}>
                  <TableCell className="py-3 text-sm text-neutral-900">{layout.name}</TableCell>
                  <TableCell className="py-3 text-sm text-neutral-900">{layout.total_semi_cama}</TableCell>
                  <TableCell className="py-3 text-sm text-neutral-900">{layout.total_cama}</TableCell>
                  <TableCell className="py-3">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Eliminar layout"
                      className="text-[#E87B7B]"
                      onClick={() => setLayoutToDelete(layout)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuevo layout</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="layout-name" className="text-sm font-medium text-neutral-600">
                Nombre
              </label>
              <Input
                id="layout-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
                placeholder="Ej: Un piso - 40 asientos"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="layout-semi-cama" className="text-sm font-medium text-neutral-600">
                Asientos Semi Cama
              </label>
              <Input
                id="layout-semi-cama"
                type="number"
                min={0}
                max={100}
                value={totalSemiCama}
                onChange={(e) => setTotalSemiCama(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="layout-cama" className="text-sm font-medium text-neutral-600">
                Asientos Cama
              </label>
              <Input
                id="layout-cama"
                type="number"
                min={1}
                max={100}
                value={totalCama}
                onChange={(e) => setTotalCama(e.target.value)}
                required
              />
            </div>
            <p className="text-sm text-neutral-600">
              Los asientos se numeran solos: primero Semi Cama, después Cama.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleCreateSubmit} disabled={!valid || saving}>
              {saving ? "Guardando..." : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={layoutToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setLayoutToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Eliminar este layout?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-neutral-600">Esta acción no se puede deshacer.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLayoutToDelete(null)}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleConfirmDelete}>
              Eliminar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
