import { expect,test } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';

test('forced WebGL2 starts the real editor and preserves SteadySplats cleanup/Undo',async ({page})=>{
  const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/?graphics=webgl2');
  await expect(page.getByRole('button',{name:'Open scene',exact:true})).toBeEnabled();
  await expect(page.locator('canvas').first()).toHaveAttribute('data-graphics-backend','webgl2');
  await page.getByLabel('Open scene files').setInputFiles({name:'webgl-basic.ply',mimeType:'application/octet-stream',buffer:Buffer.from(gaussianPly(0))});
  await expect(page).toHaveTitle('webgl-basic.ply — SplatView');
  await page.getByRole('button',{name:'Tools',exact:true}).click();
  const tools=page.getByRole('complementary',{name:'Tools',exact:true});
  await tools.getByRole('button',{name:'Settings',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Settings',exact:true});
  await settings.getByRole('combobox',{name:'Gaussian renderer',exact:true}).selectOption('steady');
  await expect(settings.getByText('Preparing SteadySplats…',{exact:true})).toBeHidden();
  await expect(settings.getByText('SteadySplats is unavailable for this view. Using sorted rendering.',{exact:true})).toHaveCount(0);
  await settings.getByRole('button',{name:'Close Settings',exact:true}).click();
  await tools.getByRole('button',{name:'Select all',exact:true}).click();
  await expect(tools.locator('.model-stats')).toHaveText('3/3 splats | SH0');
  await tools.getByRole('button',{name:'Delete selected',exact:true}).click();
  await expect(tools.locator('.model-stats')).toHaveText('0/0 splats | SH0');
  await tools.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(tools.locator('.model-stats')).toHaveText('3/3 splats | SH0');
  expect(errors).toEqual([]); await expect(page.getByRole('alert')).toHaveCount(0);
});
test('real WebGL context loss replaces the React canvas and retains edited native history',async ({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/?graphics=webgl2');await expect(page.getByRole('button',{name:'Open scene',exact:true})).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({name:'webgl-recover.ply',mimeType:'application/octet-stream',buffer:Buffer.from(gaussianPly(3))});
  await expect(page).toHaveTitle('webgl-recover.ply — SplatView');await page.getByRole('button',{name:'Tools',exact:true}).click();
  const tools=page.getByRole('complementary',{name:'Tools',exact:true});await tools.getByRole('button',{name:'Select all',exact:true}).click();
  await tools.getByRole('button',{name:'Delete selected',exact:true}).click();await expect(tools.locator('.model-stats')).toHaveText('0/0 splats | SH3');
  const before=await page.getByLabel('SplatView scene').elementHandle();
  const supported=await before!.evaluate(element=>{
    const gl=(element as HTMLCanvasElement).getContext('webgl2')!,extension=gl.getExtension('WEBGL_lose_context');
    if(!extension) return false; extension.loseContext();return true;
  });
  expect(supported).toBe(true);
  await expect.poll(()=>before!.evaluate(element=>element.isConnected)).toBe(false);
  await expect(page.getByLabel('SplatView scene')).toHaveAttribute('data-graphics-backend','webgl2');
  await expect(tools.getByRole('button',{name:'Undo',exact:true})).toBeEnabled();
  await tools.getByRole('button',{name:'Undo',exact:true}).click();await expect(tools.locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await expect(page.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);
});
