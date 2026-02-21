import { useQuery } from "@tanstack/react-query";

import { useApi } from "../api/api";

export type TaxProfile = {
  vat_enabled: boolean;
  small_business_notice?: string | null;
};

export function useTaxProfile() {
  const api = useApi();
  return useQuery({
    queryKey: ["tax-profile"],
    queryFn: () => api.request<TaxProfile>("/reports/tax-profile"),
  });
}

