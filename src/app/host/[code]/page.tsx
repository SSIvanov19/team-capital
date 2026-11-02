import { HostRoom } from '@/components/room';
export default async function Page({params}:{params:Promise<{code:string}>}) { const {code}=await params;return <HostRoom code={code.toUpperCase()}/>; }
