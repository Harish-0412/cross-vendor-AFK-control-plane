import { Suspense } from "react";
import AuthSectionOne from "@/components/ui/auth-section-1";

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <AuthSectionOne mode="signup" />
    </Suspense>
  );
}
