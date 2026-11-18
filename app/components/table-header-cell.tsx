/** A data-table column heading in the app's standard muted, uppercase style. */
export function TableHeaderCell({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </th>
  );
}
