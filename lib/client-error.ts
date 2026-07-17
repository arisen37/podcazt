export function getApiErrorMessage(body: unknown, fallback = "Something went wrong") {
  if (!body || typeof body !== "object") return fallback;

  const response = body as {
    error?: string;
    details?: {
      fieldErrors?: Record<string, string[] | undefined>;
      formErrors?: string[];
    };
  };

  const fieldErrors = response.details?.fieldErrors;
  if (fieldErrors) {
    const messages = Object.entries(fieldErrors)
      .flatMap(([field, errors]) => (errors ?? []).map((message) => `${field}: ${message}`))
      .filter(Boolean);

    if (messages.length > 0) return messages.join(" ");
  }

  if (response.details?.formErrors?.length) return response.details.formErrors.join(" ");
  return response.error ?? fallback;
}
