#!/bin/bash

# [私たちの美学: Application Hungarian]
# strOutputFile (出力ファイル名)
strOutputFile="myshell_project_for_ai.txt"

# 出力ファイルを初期化（空にする）
echo "--- MYSHELL PROJECT SOURCE CODE ---" > "$strOutputFile"
echo "Generated at: $(date)" >> "$strOutputFile"
echo "" >> "$strOutputFile"

# git管理下のファイルを走査して、ファイル名とその中身を書き出すよ
# (画像ファイルなどのバイナリはスキップするように grep してるよ)
git ls-files | grep -E '\.(ts|js|json|css|html|d\.ts)$' | while read -r strFilePath; do
    echo "========================================" >> "$strOutputFile"
    echo " FILE: $strFilePath" >> "$strOutputFile"
    echo "========================================" >> "$strOutputFile"
    
    # ファイルの中身を出力
    cat "$strFilePath" >> "$strOutputFile"
    
    echo "" >> "$strOutputFile"
    echo "--- END OF FILE: $strFilePath ---" >> "$strOutputFile"
    echo "" >> "$strOutputFile"
done

echo "✅ Done! Please share the content of '$strOutputFile' with me."
