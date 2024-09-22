
import fs from 'fs';
import Koa from 'koa';
import path from 'path';
import { glob } from "glob";
import moment from "moment";
import crypto from "crypto";
import mount from "koa-mount";
import Router from 'koa-router';
import koaStatic from "koa-static";
import { koaBody } from 'koa-body';
const d = require("dedent").default;
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as config from './config';
// 
const app = new Koa();
const router = new Router();

let runningJob = {
    uuid: "",
    job: null as null | ChildProcessWithoutNullStreams,
    status: 0 as 0 | 100 | 200 | 500,
    body: "不存在任务",
    filename: undefined as undefined | string,
    log: undefined as undefined | string,
};

// 处理文件上传请求
router.post('/upload', async (ctx, next) => {
    const videoFile = ctx.request.files?.['video']; // 获取视频文件
    const subFile = ctx.request.files?.['sub']; // 获取 .ass 文件

    if (!videoFile || !subFile) {
        ctx.status = 400;
        return ctx.body = {
            status: 400,
            uuid: runningJob.uuid,
            body: `Both video(${!!videoFile}) and sub(${!!subFile}) files are required`,
        };
    }
    if (Array.isArray(videoFile) || Array.isArray(subFile)) {
        ctx.status = 400;
        return ctx.body = {
            status: 400,
            uuid: runningJob.uuid,
            body: 'Both video and sub files are only one',
        };
    }
    if (runningJob.status === 100) {
        ctx.status = 429;
        return ctx.body = {
            status: 429,
            uuid: runningJob.uuid,
            body: "正在运行中, 请稍后再试",
        };
    }

    console.log("\n");
    console.log("====================");
    console.log(`date: ${moment().format('YYYY/MM/DD HH-mm-ss')}`);

    console.log(`video: ${videoFile.originalFilename || videoFile.newFilename}`);
    console.log(`sub: ${subFile.originalFilename || subFile.newFilename}`);


    fs.mkdirSync(config.FILE_FINAL_PATH, { recursive: true });
    fs.mkdirSync(config.FILE_STORAGE_PATH, { recursive: true });
    const FILE_TEMP_PATH = fs.mkdtempSync(path.join(config.FILE_STORAGE_PATH, moment().format('YYYYMMDD-HHmmss-')));
    const uuid = crypto.randomUUID();

    // 保存视频文件
    // const videoPath = path.join(FILE_STORAGE_PATH, videoFile.originalFilename);
    const videoPath = path.join(FILE_TEMP_PATH, videoFile.newFilename);
    fs.writeFileSync(videoPath, fs.readFileSync(videoFile.filepath));
    console.log(`视频文件 ${videoFile.originalFilename || videoFile.newFilename} 已接收并保存`);
    const videoOutPath = path.join(config.FILE_FINAL_PATH, `${uuid}.mkv`);

    // 保存 .sub 文件
    const subPath = path.join(FILE_TEMP_PATH, subFile.newFilename);
    fs.writeFileSync(subPath, fs.readFileSync(subFile.filepath));
    console.log(`sub 文件 ${subFile.originalFilename || subFile.newFilename} 已接收并保存`);

    const ps1Path = path.join(FILE_TEMP_PATH, `ProjectLoaded.ps1`);

    fs.writeFileSync(ps1Path, d`
        $code = @"
        LWLibavVideoSource("%source_file%", cachefile="%source_temp_file%.lwi")

        LoadPlugin("${config.VSFilterMod_DLL_PATH}")
        TextSubMod("${subPath}")
        "@

        $activeProject = [ShortcutModule]::p

        if ($activeProject.Script.Engine -ne [ScriptEngine]::Avisynth) {
            [MainModule]::MsgError("Load Avisynth first", "Filters > Filter Setup > Avisynth")
            exit
        }

        #if ($activeProject.VideoEncoder.GetType().Name -ne "x265Enc") {
        #    [MainModule]::MsgError("Load x265 first")
        #    exit
        #}

        $commands = [ShortcutModule]::g.DefaultCommands
        $commands.SetFilter("LWLibavVideoSource", "Source", $code)
        `);

    const getLog = async () => {
        const logFiles = (await glob(`${FILE_TEMP_PATH}/**/*.log`));
        if (!logFiles.length) return "";
        return logFiles.map(v => fs.readFileSync(v).toString())
            .reduce((a, b) => a.length > b.length ? a : b);
    }


    // 执行本地的 exe 文件
    runningJob = {
        uuid: uuid,
        job: spawn(config.STAXRIP_EXE_PATH, [
            `-ClearJobs`,
            `-LoadTemplate:x264`,
            `${videoPath}`,
            `-ExecutePowerShellFile:${ps1Path}`,
            `-SetTargetFile:${videoOutPath}`,
            `-StartEncoding`,
            `-ClearJobs`,
            `-ExitWithoutSaving`,
        ]),
        status: 100,
        body: "任务执行中",
        filename: videoOutPath,
        log: await getLog(),
    };

    // 实时输出 stdout
    runningJob.job!.stdout.on('data', (data) => {
        process.stdout.write(data);
        // ctx.body += `stdout: ${data}\n`; // 将输出附加到响应中
    });

    // 实时输出 stderr
    runningJob.job!.stderr.on('data', (data) => {
        process.stdout.write(data);
        // ctx.body += `stderr: ${data}\n`; // 将输出附加到响应中
    });

    const reload = async () => {
        if (!runningJob.job) return;
        runningJob.log = await getLog();
        setTimeout(reload, 1000);
    }
    await reload();

    runningJob.job!.on('close', async (code) => {
        console.log(`执行结束，退出码: ${code}, uuid: ${runningJob.uuid}`);
        runningJob.job = null;

        if (!fs.existsSync(videoOutPath)) {
            runningJob.status = 500;
            runningJob = {
                uuid: runningJob.uuid,
                job: null,
                status: 500,
                body: `生成错误, 文件不存在 ${code}`,
                filename: undefined,
                log: await getLog(),
            }
        } else {
            runningJob = {
                uuid: runningJob.uuid,
                job: null,
                status: 200,
                body: "已成功生成",
                filename: path.relative(process.cwd(), runningJob.filename!),
                log: await getLog(),
            };
        }
        fs.rmSync(FILE_TEMP_PATH, { recursive: true, force: true, });
    });

    return ctx.body = {
        status: 100,
        uuid: runningJob.uuid,
        body: "正在运行中",
    };

}).get("/nowjob", (ctx, next) => {
    const id = ctx.request.query["id"];
    if (id !== runningJob.uuid) {
        ctx.status = 403;
        return ctx.body = {
            status: 403,
            body: `当前id不存在`,
        };
    }

    switch (runningJob.status) {
        case 0:
            return ctx.body = {
                status: 0,
                id: runningJob.uuid,
                body: "任务未启动",
            };
        case 100:
            return ctx.body = {
                status: 100,
                body: "运行中, 请稍后",
                log: runningJob.log,
            };
        case 200:
            return ctx.body = {
                status: 200,
                body: "压制完毕",
                filepath: runningJob.filename,
                log: runningJob.log,
            };
        case 500:
            ctx.status = 500;
            return ctx.body = {
                status: 500,
                body: "压制失败了...详情请看log",
                filepath: runningJob.filename,
                log: runningJob.log,
            };
        default:
            ctx.status = 418;
            return ctx.body = {
                status: runningJob.status,
                body: "未知的status, 死球了",
                filepath: runningJob.filename,
                log: runningJob.log,
            };
    }

}).get("/", (ctx, next) => {
    ctx.body = {
        status: 200,
        body: "hello world",
    };
});

app.use(async (ctx, next) => {
    await next();

    ctx.body = {
        ...(typeof ctx.body === "object" ? ctx.body : { body: ctx.body }),
    };
});


app.use(koaBody({
    multipart: true,
    formidable: {
        keepExtensions: true,
    },
    // formLimit: '10mb', // 可以根据需要调整文件大小限制
}));
app.use(mount("/finnal", koaStatic(path.join(process.cwd(), "finnal"))));
app.use(router.routes()).use(router.allowedMethods());


app.listen(3000, () => {
    console.log('Koa 服务器已启动，监听端口 3000');
});
