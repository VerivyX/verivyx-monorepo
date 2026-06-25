import { redirect } from 'next/navigation';

export default function ScriptPage() {
  redirect('/dashboard/integrations?tab=embed');
}
