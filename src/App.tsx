import { useRef, useEffect } from "react";
import * as tf from '@tensorflow/tfjs';
import * as ort from 'onnxruntime-web/webgpu';
import { fabric } from 'fabric';

interface ImageObject {
    fabricImage: fabric.Image;
    embed: ort.Tensor | null;
    points: tf.Tensor2D | null;
}
interface CustomCanvas extends fabric.Canvas {
    lastPosX: number;
    lastPosY: number;
    isDragging: boolean;
}

ort.env.wasm.wasmPaths = '/wasm-files/'
export default function App() {
    const canvasRef = useRef<fabric.Canvas | null>(null);
    const images = useRef<ImageObject[]>([]);
    const selectedImage = useRef<ImageObject | null>(null);
    const encoderSession = useRef<ort.InferenceSession | null>(null);
    const decoderSession = useRef<ort.InferenceSession | null>(null);

    useEffect(() => {
        const canvas = new fabric.Canvas('canvas', {
            backgroundColor: 'Gainsboro',
            preserveObjectStacking: true,
        }) as CustomCanvas;
        canvas.on('mouse:down', handleOnMouseDown);
        canvas.on('dragover', handleDragOver);
        canvas.on('drop', handleOnDrop);
        canvas.on('selection:updated', handleSelection);
        canvas.on('selection:created', handleSelection);            
        canvas.on('selection:cleared', () => {
            selectedImage.current = null;
        });
        canvas.on('mouse:down', function(opt: fabric.IEvent) {
          const evt = opt.e as MouseEvent;
          if (evt.metaKey === true) {
            canvas.isDragging = true;
            canvas.selection = false;
            canvas.lastPosX = evt.clientX;
            canvas.lastPosY = evt.clientY;
          }
        });
        canvas.on('mouse:move', function(opt: fabric.IEvent) {
            if (canvas.isDragging) {
                const e = opt.e as MouseEvent;
                const vpt = canvas.viewportTransform;
                if (vpt) {
                    vpt[4] += e.clientX - canvas.lastPosX;
                    vpt[5] += e.clientY - canvas.lastPosY;
                }
                canvas.requestRenderAll();
                canvas.lastPosX = e.clientX;
                canvas.lastPosY = e.clientY;
            }
        });
        canvas.on('mouse:up', function() {
          // on mouse up we want to recalculate new interaction
            // for all objects, so we call setViewportTransform
            const viewportTransform = canvas.viewportTransform as number[];
            canvas.setViewportTransform(viewportTransform);
            canvas.isDragging = false;
            canvas.selection = true;
        });
        canvas.on('mouse:wheel', function(opt: fabric.IEvent) {
          const e = opt.e as WheelEvent;
          const delta = e.deltaY;
          let zoom = canvas.getZoom();
          zoom *= 0.999 ** delta;
          if (zoom > 20) zoom = 20;
          if (zoom < 0.01) zoom = 0.01;
          canvas.zoomToPoint({ x: e.offsetX, y: e.offsetY }, zoom);
          e.preventDefault();
          e.stopPropagation();
        });
        
        canvasRef.current = canvas;
        console.log('canvas created');
        return () => {
            canvas.dispose();
        }
    }, []);

    useEffect(() => {
        window.addEventListener('keydown', handleOnKeyDown);
        return () => {
            window.removeEventListener('keydown', handleOnKeyDown);
        };
    }, []);
    
    useEffect(() => {
        async function loadModels() {
            try {
                encoderSession.current = await ort.InferenceSession.create('/models/mobile_sam_encoder_no_preprocess.onnx', { executionProviders: ['webgpu'] });
                decoderSession.current = await ort.InferenceSession.create('/models/mobilesam.decoder.onnx', { executionProviders: ['webgpu'] });
            } catch (error) {
                console.error('Failed to load models:', error);
            }
        }
        loadModels();
        return () => {
            if (encoderSession.current) {
                encoderSession.current.release();
            }
            if (decoderSession.current) {
                decoderSession.current.release();
            }
        };
    }, []);

    useEffect(() => {
        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible' && canvasRef.current) {
                canvasRef.current.requestRenderAll();
            }
        };
        document.addEventListener('visibilitychange', handleVisibilityChange);
        return () => {
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, []);

    async function handleSelection(opt: fabric.IEvent) {
        const selected = opt.selected ? opt.selected[0] as fabric.Image : null;
        if (selected == null) {
            return;
        }
        selectedImage.current = images.current.find((image) => image.fabricImage === selected) as ImageObject;
        const group = selected.group as fabric.Group;
        if (group) {
            group.set({
                borderColor: 'black',
                cornerColor: 'white',
                cornerStrokeColor: 'black',
                transparentCorners: false
            });
        }
    }

    //culprit, i wasnt scaling the image to 1024x1024 properly, ort.Tensor resize was just adding border 
    async function encode(image: ImageObject): Promise<ort.Tensor> {
        const imageTensor = tf.image.resizeBilinear(tf.browser.fromPixels(image.fabricImage.getElement()), [1024, 1024]).concat(tf.ones([1024, 1024, 1], 'float32').mul(255), 2);
        const imageData = new ImageData(new Uint8ClampedArray(await imageTensor.data()), 1024, 1024);
        imageTensor.dispose();
        const imageDataTensor = await ort.Tensor.fromImage(imageData);

        const encoder_inputs = { "input_image": imageDataTensor };

        const session = encoderSession.current ? encoderSession.current as ort.InferenceSession : null;
        if (session == null) {
            throw new Error('encoder not loaded');
        }
        const output = await session.run(encoder_inputs);
        const image_embedding = output['image_embeddings'];
        return image_embedding;

        imageDataTensor.dispose();
    }

    async function decode(image: ImageObject): Promise<ort.InferenceSession.OnnxValueMapType> {
        const input_points = image.points as tf.Tensor2D;
        const additional_point = tf.tensor([[0.0, 0.0]], [1,2], 'float32')
        const point_coords = tf.concat([input_points, additional_point]).expandDims(0);
        const point_coords_ortTensor = new ort.Tensor('float32', new Float32Array(await point_coords.data()), point_coords.shape);

        const point_labels_points = tf.ones([input_points.shape[0]], 'float32');
        const point_labels = tf.concat([point_labels_points, tf.tensor([0], undefined, 'float32')]).expandDims(0);
        const point_labels_ortTensor = new ort.Tensor('float32', new Float32Array(await point_labels.data()), point_labels.shape);

        const mask_input = tf.zeros([1,1,256,256], 'float32');
        const mask_input_ortTensor = new ort.Tensor('float32', new Float32Array(await mask_input.data()), mask_input.shape);
        const has_mask_input = tf.zeros([1], 'float32');
        const has_mask_input_ortTensor = new ort.Tensor('float32', new Float32Array(await has_mask_input.data()), has_mask_input.shape);

        const orig_im_size = tf.tensor([1024, 1024], undefined, 'float32');
        const orig_im_size_typedArray = new Float32Array(await orig_im_size.data());
        const orig_im_size_ortTensor = new ort.Tensor('float32', orig_im_size_typedArray, orig_im_size.shape);

        const decoder_inputs = {
            "image_embeddings": image.embed,
            "point_coords": point_coords_ortTensor,
            "point_labels": point_labels_ortTensor,
            "mask_input": mask_input_ortTensor,
            "has_mask_input": has_mask_input_ortTensor,
            "orig_im_size": orig_im_size_ortTensor 
        } as ort.InferenceSession.OnnxValueMapType;

        const session = decoderSession.current ? decoderSession.current as ort.InferenceSession : null;
        if (session == null) {
            throw new Error('decoder not loaded');
        }
        const output = await session.run(decoder_inputs) as ort.InferenceSession.OnnxValueMapType;

        additional_point.dispose();
        point_labels_points.dispose();
        point_labels.dispose();
        mask_input.dispose();
        has_mask_input.dispose();
        orig_im_size.dispose();

        point_coords_ortTensor.dispose();
        point_labels_ortTensor.dispose();
        mask_input_ortTensor.dispose();
        has_mask_input_ortTensor.dispose();
        orig_im_size_ortTensor.dispose();

        return output;
    }   

    function handleOnMouseDown(opt: fabric.IEvent) {
        const e = opt.e as MouseEvent;
        const currentImage = selectedImage.current as ImageObject;
        if (e.shiftKey && currentImage != null) {

            //scale the point to the image's local coords then to 1024x1024
            const canvas = canvasRef.current as CustomCanvas;
            const mCanvas = canvas.viewportTransform as number[];
            const mImage = currentImage.fabricImage.calcTransformMatrix();
            const mTotal = fabric.util.multiplyTransformMatrices(mCanvas, mImage);
            const pointer = opt.pointer as fabric.Point;
            const point = new fabric.Point(pointer.x, pointer.y);
            const mPoint = fabric.util.transformPoint(point, fabric.util.invertTransform(mTotal));
            const currentImageHeight = currentImage.fabricImage.height as number;
            const currentImageWidth = currentImage.fabricImage.width as number;
            const x = mPoint.x + currentImageWidth / 2;
            const y = mPoint.y + currentImageHeight / 2;

            const targetWidth = 1024;
            const targetHeight = 1024;
            const target = opt.target as fabric.Image;
            const width = target.width as number;
            const height = target.height as number;
            const scaleX = targetWidth / width;
            const scaleY = targetHeight / height;
            const newX = x * scaleX;
            const newY = y * scaleY;

            if (currentImage.points == null) {
                currentImage.points = tf.tensor([[newX, newY]], [1, 2], 'float32') as tf.Tensor2D;
            } else {
                currentImage.points = tf.concat([currentImage.points, tf.tensor([[newX, newY]], [1, 2], 'float32')], 0) as tf.Tensor2D;
            }
        }
    }

    async function handleOnDrop(opt: fabric.IEvent) {
        const e = opt.e as DragEvent;
        e.preventDefault();

        const canvas = canvasRef.current as CustomCanvas;
        const reader = new FileReader();
        reader.onload = async (eventReader: ProgressEvent<FileReader>) => {
            const image = new Image();
            image.onload = async () => {
                const imgInstance = new fabric.Image(image, {
                    left: e.x,
                    top: e.y,
                    borderColor: 'black',
                    cornerColor: 'white',
                    cornerStrokeColor: 'black',
                    transparentCorners: false
                });
                canvas.add(imgInstance);
                images.current.push({ fabricImage: imgInstance, embed: null, points: null });
            }

            const target = eventReader.target as FileReader;
            image.src = target.result as string;
        };
        const dataTransfer = e.dataTransfer as DataTransfer;
        reader.readAsDataURL(dataTransfer.files[0]);
    }

    function handleDragOver(opt: fabric.IEvent) {
         opt.e.preventDefault();
     }

    async function handleOnKeyDown(e: KeyboardEvent) {
        const current = selectedImage.current as ImageObject;
        if (e.key === 'c' && current != null) {
            const image = current.fabricImage as fabric.Image;
            const originalWidth = image.width as number;
            const originalHeight = image.height as number;

            if (current.embed == null) {
                current.embed = await encode(current);
            }
            //get mask
            const output = await decode(current);

            //apply mask to image, TODO: toCanvasElement returns 0,0,0,255 when transparent, turning it black
            const originalImageCanvas = image.toCanvasElement({withoutTransform: true});
            const originalImageTensor = tf.image.resizeBilinear(tf.browser.fromPixels(originalImageCanvas), [1024, 1024]).reshape([1024*1024, 3]).concat(tf.ones([1024*1024, 1], 'float32').mul(255), 1);
            const maskImageData = output['masks'].toImageData();

            let maskTensor = tf.tensor(maskImageData.data, [maskImageData.data.length/4, 4], 'float32');
            maskTensor = maskTensor.slice([0,0], [-1, 3]);
            maskTensor = maskTensor.notEqual(0).any(1).cast('int32').reshape([maskImageData.data.length/4, 1]).tile([1,4]);
            let resultTensor = maskTensor.mul(originalImageTensor); 
            resultTensor = tf.image.resizeBilinear(resultTensor.reshape([1024, 1024, 4]) as tf.Tensor3D, [originalHeight, originalWidth]);
            const resultImageData = new ImageData(new Uint8ClampedArray(await resultTensor.data()), originalWidth, originalHeight);

            //transformations to match the mask on the image on the canvas 
            const boundingBox = findBoundingBox(resultTensor as tf.Tensor3D);
            const left = image.left as number;
            const top = image.top as number;
            const resImage = new fabric.Image(await createImageBitmap(resultImageData), {
                left: left + boundingBox.minX,
                top: top + boundingBox.minY,
                cropX: boundingBox.minX,
                cropY: boundingBox.minY,
                width: boundingBox.maxX - boundingBox.minX,
                height: boundingBox.maxY - boundingBox.minY,
                borderColor: 'black',
                cornerColor: 'white',
                cornerStrokeColor: 'black',
                transparentCorners: false
            });
            const canvas = canvasRef.current as CustomCanvas;
            const mImage = resImage.calcTransformMatrix();
            const opt = fabric.util.qrDecompose(mImage);
            resImage.set(opt);
           
            const points = current.points as tf.Tensor2D;
            points.dispose();
            current.points = null;

            images.current.push({ fabricImage: resImage, embed: null, points: null });
            canvas.add(resImage);
            canvas.setActiveObject(resImage);

            originalImageTensor.dispose();
            maskTensor.dispose();
            resultTensor.dispose();
        }
    }

    function findBoundingBox(tensor: tf.Tensor3D) {
        const [height, width, _] = tensor.shape;
        return tf.tidy(() => {  
            const mask = tensor.slice([0,0,3]);
            const opaqueMask = mask.greater(tf.scalar(0));
            const rowMaskArray = opaqueMask.any(1).arraySync() as number[][];
            const colMaskArray = opaqueMask.any(0).arraySync() as number[][];

            const boundingBox = {minX: 0, minY: 0, maxX: 0, maxY: 0};
            for (let i=0;i<height;i++) {
                if (rowMaskArray[i][0]) {
                    boundingBox.minY = i;
                    break;
                }
            }
            for (let i=height-1;i>=0;i--) {
                if (rowMaskArray[i][0]) {
                    boundingBox.maxY = i;
                    break;
                }
            }
            for (let i=0;i<width;i++) {
                if (colMaskArray[i][0]) {
                    boundingBox.minX = i;
                    break;
                }
            }
            for (let i=width-1;i>=0;i--) {
                if (colMaskArray[i][0]) {
                    boundingBox.maxX = i;
                    break;
                }
            }
            return boundingBox;
        });

    }


    return (
        <main >
            <canvas id="canvas" width={window.innerWidth} height={window.innerHeight} tabIndex={0}/> 
        </main>
    );
}
