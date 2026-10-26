import {expect,it} from 'vitest';
import {interactiveDisplayPrecision} from '../src/renderer/displayPrecision';
it('uses reduced display keys only for changed poses within the same owner and refines the resting view exactly',()=>{
  const view={owner:{},scene:{},camera:{},revision:4};
  expect(interactiveDisplayPrecision(undefined,view)).toBe(32);
  expect(interactiveDisplayPrecision(view,{...view,revision:5})).toBe(24);
  expect(interactiveDisplayPrecision(view,{...view})).toBe(32);
  for(const changed of [{...view,owner:{}},{...view,scene:{}},{...view,camera:{}}])expect(interactiveDisplayPrecision(view,{...changed,revision:5})).toBe(32);
});
