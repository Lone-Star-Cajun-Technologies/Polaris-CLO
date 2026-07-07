/** Shared QC security-category classification. */
export const SECURITY_CATEGORY_PATTERN =
  /security|secret|vulnerability|vuln|auth|crypto|injection|xss|csrf|sql/i;

export function isSecurityCategory(category: string | undefined): boolean {
  if (!category) return false;
  return SECURITY_CATEGORY_PATTERN.test(category);
}
