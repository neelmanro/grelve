import { redirect } from "next/navigation";

/** @deprecated Use `/mock/task-breakdown` */
export default function NewMockUiLegacyRedirect() {
  redirect("/mock/task-breakdown");
}
