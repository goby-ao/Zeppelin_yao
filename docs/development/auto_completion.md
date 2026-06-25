自动补全文档


zeppelin_home/interpreter/sh/interpreter-setting.json 里面有开关,决定了是否打开自动补全

    "editor": {
      "language": "sh",
      "editOnDblClick": false,
      "completionSupport": false
    }

当前修改是自动补全仅在前端进行，不请求后端（性能更好，够用暂时）
补全的规则写死在: paragraph.controller.js
