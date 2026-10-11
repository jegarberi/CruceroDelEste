import { Suspense } from "react";
import { Navbar } from "@/components/navigation/Navbar";
import { Footer } from "@/components/sections/Footer";
import { PagoContent } from "./PagoContent";

export default function PagoPage() {
  return (
    <>
      <Navbar />
      <Suspense fallback={null}>
        <PagoContent />
      </Suspense>
      <Footer />
    </>
  );
}
