import { ProjectorRoom } from '@/components/room';
export default async function Page({params,searchParams}:{params:Promise<{code:string}>;searchParams:Promise<{token?:string}>}) { const [{code},{token}]=await Promise.all([params,searchParams]);return <ProjectorRoom code={code.toUpperCase()} token={token}/>; }
