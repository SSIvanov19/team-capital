import { PlayerRoom } from '@/components/room';
export default async function Page({params}:{params:Promise<{code:string}>}) { const {code}=await params;return <PlayerRoom code={code.toUpperCase()}/>; }
