import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {Question} from '../shared/model.ts';

type ImagePatch={source:string;before:unknown;previous?:unknown[];after:any};
const patchFile=resolve('seed/option-image-patches.json');
const patches:{patches:ImagePatch[]}=existsSync(patchFile)?JSON.parse(readFileSync(patchFile,'utf8')):{patches:[]};

// 仅兼容原稿导入时的已知错误；作者改动过的选项或结算素材不覆盖。
export function normalizeImportedImages<T extends Question>(question:T):T {
 if(question.kind!=='choice')return question;
 const patch=patches.patches.find(p=>p.source===question.source);
 if(!patch)return question;
 const content={options:question.config.options,answerGallery:question.answerGallery??null,answerImage:question.answerImage??null};
 const previous='previous' in patch&&Array.isArray(patch.previous)?patch.previous:[];
 if(![patch.before,...previous].some(candidate=>isDeepStrictEqual(content,candidate)))return question;
 const corrected={...question,config:{...question.config,options:structuredClone(patch.after.options)}} as T;
 if(patch.after.answerGallery)corrected.answerGallery=structuredClone(patch.after.answerGallery);else delete corrected.answerGallery;
 if(patch.after.answerImage)corrected.answerImage=patch.after.answerImage;else delete corrected.answerImage;
 return corrected;
}
