import { EmptyState } from "@market/ui";

export default function StockNotFound() {
  return (
    <EmptyState title="No security with that ticker">
      It is not in the loaded universe. Press / to search, or add the symbol to config/universe.json
      and run <code>pnpm worker bootstrap</code>.
    </EmptyState>
  );
}
