import { Recover } from '@/components/join';
export default async function Page({searchParams}:{searchParams:Promise<{room?:string}>}) { const {room}=await searchParams;return <Recover initialRoom={room}/>; }
