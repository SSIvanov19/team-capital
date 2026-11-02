import { Join } from '@/components/join';
export default async function Page({params}:{params:Promise<{code:string}>}) { const {code}=await params;return <Join code={code.toUpperCase()}/>; }
