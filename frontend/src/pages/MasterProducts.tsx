import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApi } from "../lib/api";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";

type MasterProduct = {
  id: string;
  title: string;
  platform: string;
  region: string;
  ean?: string | null;
};

export function MasterProductsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({ title: "", platform: "", region: "" });

  const list = useQuery({
    queryKey: ["master-products"],
    queryFn: () => api.request<MasterProduct[]>("/master-products"),
  });

  const create = useMutation({
    mutationFn: () =>
      api.request<MasterProduct>("/master-products", {
        method: "POST",
        json: { ...form },
      }),
    onSuccess: async () => {
      setForm({ title: "", platform: "", region: "" });
      await qc.invalidateQueries({ queryKey: ["master-products"] });
    },
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = list.data ?? [];
    if (!q) return all;
    return all.filter((m) => `${m.title} ${m.platform} ${m.region}`.toLowerCase().includes(q));
  }, [list.data, search]);

  return (
    <div className="space-y-4">
      <div className="text-xl font-semibold">Master Products</div>

      <Card>
        <CardHeader>
          <CardTitle>Create</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={form.title} onChange={(e) => setForm((s) => ({ ...s, title: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label>Platform</Label>
            <Input value={form.platform} onChange={(e) => setForm((s) => ({ ...s, platform: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label>Region</Label>
            <Input value={form.region} onChange={(e) => setForm((s) => ({ ...s, region: e.target.value }))} />
          </div>
          <div className="flex items-end">
            <Button
              onClick={() => create.mutate()}
              disabled={!form.title.trim() || !form.platform.trim() || !form.region.trim() || create.isPending}
            >
              Create
            </Button>
          </div>
          {create.isError && (
            <div className="md:col-span-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(create.error as Error).message}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>List</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <Button variant="secondary" onClick={() => list.refetch()}>
              Refresh
            </Button>
          </div>

          {list.isError && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {(list.error as Error).message}
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Region</TableHead>
                <TableHead className="text-right">EAN</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.title}</TableCell>
                  <TableCell>{m.platform}</TableCell>
                  <TableCell>{m.region}</TableCell>
                  <TableCell className="text-right">{m.ean ?? ""}</TableCell>
                </TableRow>
              ))}
              {!rows.length && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-gray-500">
                    No data.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

