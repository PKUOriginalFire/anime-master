import {expect,test} from '@playwright/test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {freshState,questionSchema,type Show,type StageState} from '../shared/model.ts';
import {publicPacket} from '../server/stage.ts';
import {Stage} from '../src/Stage.tsx';

const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
for(const [width,height] of [[1920,1080],[3904,672]]){
 test(`舞台 ${width}×${height} 的密集配图保留可见空间`,async({page})=>{
  await page.setViewportSize({width,height});
  const draw=async(question:Record<string,unknown>,state:Partial<StageState>)=>{
   const content=questionSchema.parse({title:'测试题',prompt:'请观察',answer:'答案',explanation:'',notes:'',source:'',...question});
   const show:Show={id:'layout',ownerId:'author',title:'活动',width,height,version:1,state:{...freshState(),...state},
    items:[{id:'item',type:'question',question:{...content,id:'q',authorId:'author',author:'',status:'accepted',version:1,updatedAt:''}}]};
   const html=renderToStaticMarkup(createElement(Stage,{packet:publicPacket(show,true)}));
   await page.setContent('<style>'+css+'.stage-canvas{transform:none!important}</style><div class="display-page">'+html+'</div>');
  };
  const options=Array.from('ABCDEFGH',id=>({id,text:id,image:'picture'}));
  await draw({kind:'choice',config:{options,correctId:'H'}},{phase:'question'});
  const images=page.locator('.stage-option-images img');
  await expect(images).toHaveCount(8);
  expect(await images.evaluateAll(nodes=>Math.min(...nodes.map(n=>n.clientHeight)))).toBeGreaterThan(60);

  const clues=Array.from({length:20},(_,i)=>({id:String(i),text:'最后一条线索',image:'picture'}));
  await draw({kind:'reasoning',config:{clues}},{phase:'question',step:20});
  const cluesOnStage=page.locator('.stage-clue');
  await expect(cluesOnStage).toHaveCount(20);
  await expect(cluesOnStage.last().locator('b')).toHaveText('20');
  expect(await cluesOnStage.locator('img').evaluateAll(nodes=>Math.min(...nodes.map(n=>n.clientHeight)))).toBeGreaterThan(20);

  await draw({kind:'scene',config:{image:'picture',regions:[]}},{phase:'full'});
  const fits=await page.locator('.scene-figure img').evaluate(image=>{
   const frame=image.parentElement!.getBoundingClientRect();
   const rect=image.getBoundingClientRect();
   return rect.height>0&&rect.top>=frame.top&&rect.bottom<=frame.bottom+1;
  });
  expect(fits).toBe(true);
 });
}
