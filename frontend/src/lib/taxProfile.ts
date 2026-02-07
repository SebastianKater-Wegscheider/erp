import { useQuery } from "@tanstack/react-query";

import { useApi } from "./api";

export type TaxProfileOut = {
  vat_enabled: boolean;
  small_business_notice: string | null;
};

export function useTaxProfile() {
  const api = useApi();
  return useQuery({
    queryKey: ["tax-profile"],
    queryFn: () => api.request<TaxProfileOut>("/reports/tax-profile"),
    staleTime: 1000 * 60 * 10,
  });
}

